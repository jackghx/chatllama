require('dotenv').config();

const bool = (v, fallback = false) => {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

// Number('') is 0, so an empty variable has to be caught before coercion.
const num = (v, fallback) => {
  if (v === undefined || String(v).trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const list = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const oneOf = (v, allowed, fallback) => {
  const found = String(v || '').toLowerCase();
  return allowed.includes(found) ? found : fallback;
};

module.exports = {
  ollama: {
    host: (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
    timeoutMs: num(process.env.OLLAMA_TIMEOUT_MS, 120000),
  },

  access: {
    replyMode: oneOf(process.env.REPLY_MODE, ['always', 'prefix'], 'always'),
    commandPrefix: process.env.COMMAND_PREFIX || '/ai',

    allowedContacts: list(process.env.ALLOWED_CONTACTS),
    captureIds: bool(process.env.CAPTURE_IDS, false),
    ignoreOlderThanSeconds: num(process.env.IGNORE_OLDER_THAN_SECONDS, 30),

    allowGroups: bool(process.env.ALLOW_GROUPS, false),
    maxRepliesPerHour: num(process.env.MAX_REPLIES_PER_HOUR, 20),
  },

  webhook: {
    url: process.env.N8N_WEBHOOK_URL || '',
    fireInSim: bool(process.env.WEBHOOK_IN_SIM, false),
  },

  summary: {
    idleMinutes: num(process.env.SUMMARY_IDLE_MINUTES, 10),
    maxMessages: num(process.env.SUMMARY_MAX_MESSAGES, 15),
  },

  assistant: {
    model: process.env.ASSISTANT_MODEL || 'llama3.1:8b',
    memoryWindow: num(process.env.ASSISTANT_MEMORY_WINDOW, 20),

    systemPromptFile: process.env.SYSTEM_PROMPT_FILE || '',
    systemPrompt: process.env.SYSTEM_PROMPT || '',

    aiPrefix: process.env.AI_PREFIX || '[AI]',
    aiPrefixMode: oneOf(process.env.AI_PREFIX_MODE, ['always', 'first', 'never'], 'always'),
  },
};
