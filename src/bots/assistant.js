// Persona lives in prompts/assistant.md, SYSTEM_PROMPT or SYSTEM_PROMPT_FILE.
const { assistant: cfg, summary: summaryCfg, webhook } = require('../config');
const { generate } = require('../lib/ollama');
const { ConversationStore } = require('../lib/memory');
const { Digest } = require('../lib/digest');
const { notify } = require('../lib/webhook');
const { loadSystemPrompt, loadSummaryPrompt } = require('../lib/prompt');
const { run } = require('../lib/runner');

const { text: systemPrompt, source: promptSource } = loadSystemPrompt();
const summaryPrompt = loadSummaryPrompt();

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
 * One notification for a whole exchange, written when the conversation has
 * gone quiet. This is the message that reaches you, so it costs a second
 * generation, but it runs after the reply has already been sent.
 */
async function summarise(conversationId, { messages, meta, reason }) {
  // lines() hands back the live array and this runs from a timer rather than
  // the queue, so the copy has to be taken before anything is awaited.
  const history = memory.lines(conversationId).slice();
  if (!history.length) return;

  let briefing = '';
  try {
    briefing = await generate({
      model: cfg.model,
      prompt: [summaryPrompt, '', 'Transcript:', ...history, '', 'Briefing:'].join('\n'),
      stop: ['Transcript:', 'User:', `${LABEL}:`],
    });
  } catch (err) {
    // Still worth notifying: the transcript below carries the exchange itself.
    console.error('[digest] summary generation failed:', err.message);
  }

  console.log(`[digest] ${conversationId}: ${messages} exchange(s), ${reason}`);

  notify({
    event: 'conversation_summary',
    bot: 'assistant',
    from: meta.from || 'simulation',
    reason,
    messages,
    summary: briefing,
    transcript: history,
  });
}

const digest = new Digest({
  idleMs: summaryCfg.idleMinutes * 60 * 1000,
  maxMessages: summaryCfg.maxMessages,
  onFlush: summarise,
});

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
    });
  } catch (err) {
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
  ],
  handle,
  // Pending summaries only exist in memory, so a restart would drop them.
  shutdown: () => digest.flushAll(),
});
