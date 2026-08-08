/**
 * assistant: answers WhatsApp messages on behalf of the account owner.
 *
 * The persona is not in this file. It comes from prompts/assistant.md,
 * SYSTEM_PROMPT or SYSTEM_PROMPT_FILE, because tailoring the voice is the
 * point of running this rather than an off the shelf auto responder.
 */
const { assistant: cfg, webhook } = require('../config');
const { generate } = require('../lib/ollama');
const { ConversationStore } = require('../lib/memory');
const { notify } = require('../lib/webhook');
const { loadSystemPrompt } = require('../lib/prompt');
const { run } = require('../lib/runner');

const { text: systemPrompt, source: promptSource } = loadSystemPrompt();

const memory = new ConversationStore(cfg.memoryWindow);

/** Conversations that have already carried the notice, for prefix mode "first". */
const disclosed = new Set();

/**
 * The transcript label is fixed at "Assistant:" rather than reusing the
 * disclosure notice. They are separate things: one structures the prompt, the
 * other is shown to the person, and the notice can be switched off entirely.
 */
const TRANSCRIPT_LABEL = 'Assistant';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Remove any leading transcript label or notice the model produced itself.
 *
 * The notice is attached below, in code. If the model also emits one, the
 * reply goes out carrying it twice.
 */
function stripLeadingMarkers(raw) {
  const patterns = [new RegExp(`^${TRANSCRIPT_LABEL}\\s*:\\s*`, 'i')];
  if (cfg.aiPrefix) patterns.push(new RegExp(`^${escapeRe(cfg.aiPrefix)}\\s*:?\\s*`));

  let out = raw.trim();
  for (let changed = true; changed; ) {
    changed = false;
    for (const pattern of patterns) {
      const next = out.replace(pattern, '');
      if (next !== out) {
        out = next;
        changed = true;
      }
    }
  }
  return out.trim();
}

/**
 * Attach the self-disclosure notice.
 *
 * Applied here rather than asked for in the system prompt. There is a
 * precedent in this repo: the quiz bot asked the model to emit a fixed token
 * on every reply, the model dropped it often enough to corrupt the score, and
 * the fix was to stop depending on it. The same failure here is worse, because
 * the person on the other end cannot tell it happened.
 */
function withNotice(conversationId, answer) {
  if (cfg.aiPrefixMode === 'never') return answer;
  if (cfg.aiPrefixMode === 'first' && disclosed.has(conversationId)) return answer;

  disclosed.add(conversationId);
  return `${cfg.aiPrefix} ${answer}`;
}

async function handle(conversationId, text, ctx) {
  const history = memory.lines(conversationId);
  const prompt = [systemPrompt, ...history, `User: ${text}`, `${TRANSCRIPT_LABEL}:`].join('\n');

  let raw;
  try {
    raw = await generate({
      model: cfg.model,
      prompt,
      // Without stop sequences the model writes both sides of the
      // conversation, inventing the user's next message and answering it.
      stop: ['User:', '\nUser:', `\n${TRANSCRIPT_LABEL}:`],
    });
  } catch (err) {
    console.error('[assistant] generation failed:', err.message);
    return withNotice(conversationId, 'Something went wrong reaching the model. Try again in a moment.');
  }

  const answer = stripLeadingMarkers(raw);
  if (!answer) {
    console.error('[assistant] model returned an empty reply');
    return withNotice(conversationId, 'I did not manage an answer there. Try asking again.');
  }

  memory.push(conversationId, `User: ${text}`);
  memory.push(conversationId, `${TRANSCRIPT_LABEL}: ${answer}`);

  const reply = withNotice(conversationId, answer);

  if (!ctx.isSim || webhook.fireInSim) {
    notify({
      event: 'ai_message',
      bot: 'assistant',
      from: ctx.from || 'simulation',
      userMessage: text,
      botReply: reply,
    });
  }

  return reply;
}

run({
  name: 'assistant',
  clientId: 'assistant',
  startup: [
    `[prompt] loaded from ${promptSource}`,
    `[notice] ${cfg.aiPrefixMode === 'never' ? 'off' : `"${cfg.aiPrefix}", mode ${cfg.aiPrefixMode}`}`,
  ],
  handle,
});
