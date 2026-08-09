// Persona lives in prompts/assistant.md, SYSTEM_PROMPT or SYSTEM_PROMPT_FILE.
const { assistant: cfg, summary: summaryCfg, webhook, access } = require('../config');
const { generate } = require('../lib/ollama');
const { ConversationStore } = require('../lib/memory');
const { Digest } = require('../lib/digest');
const { SerialQueue } = require('../lib/queue');
const { notify } = require('../lib/webhook');
const { loadSystemPrompt, loadSummaryPrompt, loadTriagePrompt } = require('../lib/prompt');
const { run } = require('../lib/runner');

const { text: systemPrompt, source: promptSource } = loadSystemPrompt();
const summaryPrompt = loadSummaryPrompt();
const triagePrompt = loadTriagePrompt();

const memory = new ConversationStore(cfg.memoryWindow);

// Separate from AI_PREFIX, which is shown to the person and can be switched off.
const LABEL = 'Assistant';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const MARKERS = [new RegExp(`^${LABEL}\\s*:\\s*`, 'i')];
if (cfg.aiPrefix) MARKERS.push(new RegExp(`^${escapeRe(cfg.aiPrefix)}\\s*:?\\s*`));

// Models often open with the label or the prefix, which would then appear twice.
function stripMarkers(raw) {
  let out = raw.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const marker of MARKERS) {
      const next = out.replace(marker, '');
      if (next !== out) {
        out = next;
        changed = true;
      }
    }
  }
  return out.trim();
}

// Attached after generation. A model told to always emit a fixed string drops
// it eventually, and here that failure is invisible to whoever reads the reply.
function withNotice(answer, isFirstReply) {
  if (cfg.aiPrefixMode === 'never') return answer;
  if (cfg.aiPrefixMode === 'first' && !isFirstReply) return answer;
  return `${cfg.aiPrefix} ${answer}`;
}

// Both the per-message event and the digest exist to feed n8n, so neither runs
// when there is nowhere to send them.
const reportable = (ctx) => Boolean(webhook.url) && (!ctx.isSim || webhook.fireInSim);

/**
 * What the briefing comes back as when SUMMARY_FORMAT is json. Ollama enforces
 * the shape, which is why the prompt only has to explain what each field means.
 */
const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    urgency: { type: 'string', enum: ['now', 'today', 'whenever'] },
    wants: { type: 'string' },
    deadline: { type: 'string' },
    draft_reply: { type: 'string' },
  },
  required: ['urgency', 'wants', 'deadline', 'draft_reply'],
};

const URGENCY = ['now', 'today', 'whenever'];

const line = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * Returns null when the model did not produce the shape asked for, which an 8B
 * will do occasionally however the request is phrased. The caller falls back to
 * treating the text as prose rather than dropping the notification.
 */
function parseTriage(raw) {
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    // Wrapping the object in a sentence or a code fence is the common failure
    // and is worth one attempt at the outermost braces before giving up.
    const open = raw.indexOf('{');
    const close = raw.lastIndexOf('}');
    if (open === -1 || close <= open) return null;
    try {
      data = JSON.parse(raw.slice(open, close + 1));
    } catch {
      return null;
    }
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

  const urgency = String(data.urgency ?? '').toLowerCase();

  return {
    // n8n switches on this, so a value the model invented has to become a real
    // one here. Left alone it would fall through the workflow unrouted.
    urgency: URGENCY.includes(urgency) ? urgency : 'whenever',
    wants: line(data.wants),
    deadline: line(data.deadline),
    draftReply: line(data.draft_reply),
  };
}

// The fields travel as their own object, but `summary` stays a string so that
// anything already reading it, including the n8n node in docs/n8n-discord.md,
// keeps working.
const readable = (t) =>
  [t.wants, t.deadline && `Needs an answer by ${t.deadline}.`].filter(Boolean).join(' ');

/**
 * One notification for a whole exchange, written when the conversation has
 * gone quiet. This is the message that reaches you, so it costs a second
 * generation, but it runs after the reply has already been sent.
 */
async function summarise(conversationId, { messages, meta, reason }) {
  // lines() hands back the live array and this runs from a timer rather than
  // the queue, so the copy has to be taken before anything is awaited.
  const history = memory.lines(conversationId).slice();
  if (!history.length) return;

  const structured = summaryCfg.format === 'json';

  let raw = '';
  try {
    raw = await generate({
      // The briefing runs after the reply has gone out, so nobody is waiting on
      // it and it can afford a better model than the one answering.
      model: summaryCfg.model || cfg.model,
      prompt: [
        structured ? triagePrompt : summaryPrompt,
        '',
        'Transcript:',
        ...history,
        '',
        'Briefing:',
      ].join('\n'),
      // Structured output needs no stop sequences: the schema is what keeps the
      // model inside the lines, and generate() drops them there in any case.
      stop: structured ? undefined : ['Transcript:', 'User:', `${LABEL}:`],
      format: structured ? TRIAGE_SCHEMA : undefined,
      timeoutMs: summaryCfg.timeoutMs,
    });
  } catch (err) {
    // Still worth notifying: the transcript below carries the exchange itself.
    console.error('[digest] summary generation failed:', err.message);
  }

  const triage = structured ? parseTriage(raw) : null;
  if (structured && raw && !triage) {
    console.warn('[digest] the briefing did not come back as JSON, sending it as prose');
  }

  console.log(
    `[digest] ${conversationId}: ${messages} exchange(s), ${reason}` +
      (triage ? `, ${triage.urgency}` : '')
  );

  notify({
    event: 'conversation_summary',
    bot: 'assistant',
    from: meta.from || 'simulation',
    reason,
    messages,
    summary: triage ? readable(triage) : raw,
    // Null whenever the fields are not trustworthy, so a workflow can tell the
    // difference between "nothing urgent" and "the model did not answer".
    triage,
    transcript: history,
  });
}

// Briefings run off a timer rather than off the reply queue, so nothing else
// was holding them back. Ten conversations going quiet in the same minute would
// be ten generations at once, on a box that is also answering messages.
const summaries = new SerialQueue('digest');

const digest = new Digest({
  idleMs: summaryCfg.idleMinutes * 60 * 1000,
  maxMessages: summaryCfg.maxMessages,
  // push() settles when the work does, so the shutdown flush still waits for
  // the briefings rather than only for them being queued.
  onFlush: (id, meta) => summaries.push(() => summarise(id, meta)),
});

/**
 * Records a message that produced no generated reply.
 *
 * The digest is what reaches you, and it is only ever fed from handle(). In auto
 * mode most messages never get that far, so without this a conversation the
 * fixed reply dealt with would arrive as silence, which is the opposite of the
 * point of running auto mode at all.
 */
function observe(conversationId, text, ctx) {
  memory.push(conversationId, `User: ${text}`);
  if (reportable(ctx)) digest.track(conversationId, { from: ctx.from || 'simulation' });
}

/**
 * The fixed reply. No model in the path, so it is instant and cannot drift.
 *
 * It still goes through the disclosure marker and the transcript rather than
 * being sent straight from the runner, or it would be the one outbound message
 * with nothing marking it as automatic and no record that it happened.
 */
function auto(conversationId, text, ctx) {
  // The runner decides the wording, because "away 30m at the gym" has to
  // override the configured line and the runner is what holds the away state.
  // Reading AUTO_REPLY_TEXT directly here meant the command set a wording that
  // was then never used, and set an empty one to nobody being answered at all.
  const body = (ctx && ctx.autoText) || access.autoReplyText;
  if (!body) return null;

  const isFirstReply = memory.lines(conversationId).length === 0;
  const reply = withNotice(body, isFirstReply);

  memory.push(conversationId, `User: ${text}`);
  memory.push(conversationId, `${LABEL}: ${body}`);

  if (reportable(ctx)) {
    notify({
      event: 'ai_message',
      bot: 'assistant',
      from: ctx.from || 'simulation',
      userMessage: text,
      botReply: reply,
      automatic: true,
    });
    digest.track(conversationId, { from: ctx.from || 'simulation' });
  }

  return reply;
}

async function handle(conversationId, text, ctx) {
  const history = memory.lines(conversationId);
  const isFirstReply = history.length === 0;
  const prompt = [systemPrompt, ...history, `User: ${text}`, `${LABEL}:`].join('\n');

  let raw;
  try {
    raw = await generate({
      model: cfg.model,
      prompt,
      // Without these the model writes the user's next message and answers it.
      stop: ['User:', '\nUser:', `\n${LABEL}:`],
      signal: ctx.signal,
    });
  } catch (err) {
    // Not a failure: a newer message arrived and the runner is about to ask
    // again with it included. Nothing has been written to memory yet.
    if (err.name === 'Aborted') throw err;
    console.error('[assistant] generation failed:', err.message);
    return withNotice('Something went wrong reaching the model. Try again shortly.', isFirstReply);
  }

  const answer = stripMarkers(raw);
  if (!answer) {
    console.error('[assistant] model returned an empty reply');
    return withNotice('I did not manage an answer there. Try asking again.', isFirstReply);
  }

  memory.push(conversationId, `User: ${text}`);
  memory.push(conversationId, `${LABEL}: ${answer}`);

  const reply = withNotice(answer, isFirstReply);

  if (reportable(ctx)) {
    notify({
      event: 'ai_message',
      bot: 'assistant',
      from: ctx.from || 'simulation',
      userMessage: text,
      botReply: reply,
      automatic: false,
    });
    digest.track(conversationId, { from: ctx.from || 'simulation' });
  }

  return reply;
}

const digestState = digest.enabled
  ? `every ${summaryCfg.idleMinutes} quiet minutes, or ${summaryCfg.maxMessages} exchanges`
  : 'off, SUMMARY_IDLE_MINUTES is 0';

run({
  name: 'assistant',
  clientId: 'assistant',
  startup: [
    `[prompt] loaded from ${promptSource}`,
    `[notice] ${cfg.aiPrefixMode === 'never' ? 'off' : `"${cfg.aiPrefix}", mode ${cfg.aiPrefixMode}`}`,
    `[digest] ${digestState}`,
    `[briefing] ${summaryCfg.format}${summaryCfg.model ? `, model ${summaryCfg.model}` : ''}`,
  ],
  handle,
  auto,
  observe,
  // Pending summaries only exist in memory, so a restart would drop them.
  shutdown: () => digest.flushAll(),
});
