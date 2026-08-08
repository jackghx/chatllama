require('dotenv').config();

const bool = (v, fallback = false) => {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const list = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Falls back rather than throwing, so a typo cannot take the bot offline. */
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
    // always: reply to every eligible message. prefix: only to commands.
    replyMode: oneOf(process.env.REPLY_MODE, ['always', 'prefix'], 'always'),
    commandPrefix: process.env.COMMAND_PREFIX || '/ai',

    allowedContacts: list(process.env.ALLOWED_CONTACTS),
    logUnmatched: bool(process.env.LOG_UNMATCHED, false),
    ignoreOlderThanSeconds: num(process.env.IGNORE_OLDER_THAN_SECONDS, 30),

    // Auto-replying into a group answers every member's every message.
    allowGroups: bool(process.env.ALLOW_GROUPS, false),

    // Stops two auto-repliers pointing at each other from running forever.
    // Zero or less disables the limit.
    maxRepliesPerHour: num(process.env.MAX_REPLIES_PER_HOUR, 20),
  },

  webhook: {
    url: process.env.N8N_WEBHOOK_URL || '',
    fireInSim: bool(process.env.WEBHOOK_IN_SIM, false),
  },

  assistant: {
    model: process.env.ASSISTANT_MODEL || 'llama3.1:8b',
    memoryWindow: num(process.env.ASSISTANT_MEMORY_WINDOW, 20),

    // Where the persona comes from, tried in this order. See src/lib/prompt.js.
    systemPromptFile: process.env.SYSTEM_PROMPT_FILE || '',
    systemPrompt: process.env.SYSTEM_PROMPT || '',

    // The self-disclosure notice. Wording is yours; always, first (once per
    // conversation) or never controls how often it is attached.
    aiPrefix: process.env.AI_PREFIX || '[AI]',
    aiPrefixMode: oneOf(process.env.AI_PREFIX_MODE, ['always', 'first', 'never'], 'always'),
  },
};
