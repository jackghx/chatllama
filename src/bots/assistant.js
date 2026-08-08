// Persona lives in prompts/assistant.md, SYSTEM_PROMPT or SYSTEM_PROMPT_FILE.
const { assistant: cfg, webhook } = require('../config');
const { generate } = require('../lib/ollama');
const { ConversationStore } = require('../lib/memory');
const { notify } = require('../lib/webhook');
const { loadSystemPrompt } = require('../lib/prompt');
const { run } = require('../lib/runner');

const { text: systemPrompt, source: promptSource } = loadSystemPrompt();

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
