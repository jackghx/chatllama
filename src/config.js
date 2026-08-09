require('dotenv').config();

const bool = (v, fallback = false) => {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

// Three states, unlike bool. Unset means the field is left off the request
// entirely, which is what a model with no thinking capability expects.
const optBool = (v) => (v === undefined || String(v).trim() === '' ? null : bool(v));

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

// Read once up here because the default wording of the fixed reply has to tell
// people what to type, and that is this string.
const commandPrefix = process.env.COMMAND_PREFIX || '/ai';

module.exports = {
  ollama: {
    host: (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
    timeoutMs: num(process.env.OLLAMA_TIMEOUT_MS, 120000),
    think: optBool(process.env.OLLAMA_THINK),

    // How long Ollama holds the model in memory after a request. Empty leaves
    // its own default alone, which is five minutes, and briefings fire after
    // ten of silence, so on the defaults every single one loads the model off
    // disk before it can start. Sent per request rather than set on the server,
    // so this only pins the model this bot uses.
    keepAlive: (process.env.OLLAMA_KEEP_ALIVE || '').trim(),
  },

  access: {
    // always  the model answers everything
    // prefix  the model answers the command, everything else is ignored
    // auto    a fixed reply to everything, the model only on the command
    // off      nothing is answered at all
    replyMode: oneOf(process.env.REPLY_MODE, ['always', 'prefix', 'auto', 'off'], 'auto'),
    commandPrefix,

    // The fixed reply in auto mode. No model in the path, so it is instant and
    // cannot say anything that was not written here. An empty string leaves
    // auto mode behaving as prefix mode.
    autoReplyText:
      process.env.AUTO_REPLY_TEXT === undefined
        ? 'Nobody is watching this number at the moment. Send everything in one ' +
          'go rather than waiting for a reply, and it will get read. If you want ' +
          `an answer now, start a message with ${commandPrefix}.`
        : process.env.AUTO_REPLY_TEXT,

    // Measured from when they last wrote, not from when the fixed reply last
    // went out. One reply per fresh burst of contact, which is what an away
    // message is. A cooldown would fire again mid-conversation.
    autoReplyGapMinutes: num(process.env.AUTO_REPLY_GAP_MINUTES, 60),

    // The floor under that, so somebody messaging just outside the gap all day
    // is not texted every hour. 0 removes it.
    autoReplyMaxPerDay: num(process.env.AUTO_REPLY_MAX_PER_DAY, 3),

    // off  | nobody can steer it from WhatsApp
    // self | only from your own Note to Self chat
    // any  | from any one-to-one chat
    //
    // self is the default because "/ai off" typed into a friend's chat is a
    // message you have just sent that friend, and they can read it.
    ownerCommands: oneOf(process.env.OWNER_COMMANDS, ['off', 'self', 'any'], 'self'),
    ownerCommandAck: bool(process.env.OWNER_COMMAND_ACK, true),

    // Phone numbers, with the country code and no punctuation. They are
    // resolved to WhatsApp's own identifiers at startup. An entry that already
    // contains an @ is taken literally and never looked up.
    allowedContacts: list(process.env.ALLOWED_CONTACTS),
    contactCacheFile: process.env.CONTACT_CACHE_FILE || '.cache/identity.json',
    contactCacheTtlDays: num(process.env.CONTACT_CACHE_TTL_DAYS, 30),
    // The lookups are rate limited, so they are spaced out rather than sent at once.
    contactResolveDelayMs: num(process.env.CONTACT_RESOLVE_DELAY_MS, 500),

    captureIds: bool(process.env.CAPTURE_IDS, false),
    ignoreOlderThanSeconds: num(process.env.IGNORE_OLDER_THAN_SECONDS, 30),

    allowGroups: bool(process.env.ALLOW_GROUPS, false),
    maxRepliesPerHour: num(process.env.MAX_REPLIES_PER_HOUR, 20),

    // How many times a reply may be thrown away and written again because the
    // sender added something. Zero answers each message separately.
    maxInterrupts: num(process.env.MAX_INTERRUPTS, 3),

    // Sent once when a conversation hits the cap, so the silence that follows is
    // explained rather than mysterious. An empty string sends nothing.
    rateLimitNotice:
      process.env.RATE_LIMIT_NOTICE === undefined
        ? 'That is as many automatic replies as this number sends in an hour. ' +
          'Your messages are still coming through and will be read.'
        : process.env.RATE_LIMIT_NOTICE,
  },

  webhook: {
    url: process.env.N8N_WEBHOOK_URL || '',
    fireInSim: bool(process.env.WEBHOOK_IN_SIM, false),
  },

  // Lets n8n hand a message back for the bot to send, which is what turns a
  // drafted reply into one approved with a tap rather than retyped.
  send: {
    // Unset means off. The port is the switch, so there is no separate flag to
    // leave on by accident. 0 binds whatever is free, which is only useful in
    // tests.
    port:
      process.env.SEND_API_PORT === undefined || String(process.env.SEND_API_PORT).trim() === ''
        ? null
        : num(process.env.SEND_API_PORT, null),
    host: process.env.SEND_API_HOST || '127.0.0.1',
    // The digest, not the key, so a copy of .env is not a working credential.
    keyHash: (process.env.SEND_API_KEY_SHA512 || '').trim().toLowerCase(),
    maxPerMinute: num(process.env.SEND_API_MAX_PER_MINUTE, 30),
    // Off by default, so a leaked key can only reach people already allowlisted.
    allowAny: bool(process.env.SEND_API_ALLOW_ANY, false),
  },

  summary: {
    idleMinutes: num(process.env.SUMMARY_IDLE_MINUTES, 10),
    maxMessages: num(process.env.SUMMARY_MAX_MESSAGES, 15),

    // json asks for fields n8n can branch on: how urgent it is, what they want,
    // and a reply you could send back. prose is the old free-text briefing, for
    // a model too small to hold a schema.
    format: oneOf(process.env.SUMMARY_FORMAT, ['json', 'prose'], 'json'),

    // The briefing runs after the reply has gone, so it can afford a slower and
    // better model than the one answering. Empty uses the assistant's.
    model: process.env.SUMMARY_MODEL || '',

    // Its own budget, and a much larger one. OLLAMA_TIMEOUT_MS governs a person
    // sitting looking at their phone, so it has to stay short. Nobody is waiting
    // on a briefing, and it is the slower job of the two: a schema constrains
    // every token, and by the time it runs the conversation has usually been
    // idle long enough for Ollama to have unloaded the model.
    timeoutMs: num(process.env.SUMMARY_TIMEOUT_MS, 300000),
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
