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

// Unset is off. Anything else has to be a real port, because server.listen
// throws synchronously on a bad one, before the WhatsApp client is even
// created, and pm2 then burns its restart budget on a typo.
const port = (v) => {
  if (v === undefined || String(v).trim() === '') return null;
  const n = Number(v);
  if (Number.isInteger(n) && n >= 0 && n <= 65535) return n;
  console.error(`[config] SEND_API_PORT is not a port number: "${v}". The endpoint is off.`);
  return null;
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

    // Loads the model before anybody has asked it for anything.
    //
    // auto mode leaves it idle nearly all day, because the fixed reply never
    // touches it and briefings are rare, so Ollama evicts it and the first
    // prefixed message of the afternoon pays to read the weights back off disk
    // with somebody waiting on the other end. Warming when the fixed reply goes
    // out moves that cost into the seconds they spend reading it, and the fixed
    // reply is the message telling them to use the prefix in the first place.
    warmup: bool(process.env.OLLAMA_WARMUP, true),
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

    // How long a conversation keeps reaching the model after someone has used
    // the prefix once. Without it every single message needs the prefix, which
    // nobody remembers, so a question gets the fixed reply and has to be typed
    // again. 0 turns it off and makes the prefix required every time.
    followUpMinutes: num(process.env.FOLLOW_UP_MINUTES, 15),

    // The daily cap on top of that, so somebody messaging just outside the gap
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

    // Where away and mode are kept between runs. "/ai away 1w" is a promise to
    // whoever writes in, and pm2 restarting overnight is not you cancelling it.
    // What is stored is the moment the away ends rather than what is left of
    // it, so time spent down still counts. Empty turns this off, and the bot
    // starts from REPLY_MODE every time as it used to.
    stateFile: process.env.STATE_FILE === undefined ? '.cache/state.json' : process.env.STATE_FILE,

    // How long the bot keeps out of a conversation after the owner has answered
    // that person themselves, whether typed on their phone or approved from a
    // briefing. Somebody who has just replied is demonstrably at their phone,
    // so the fixed reply saying nobody is watching the number would be a lie,
    // and an approved reply goes out unmarked, meaning the person believes they
    // are talking to a human and would then be answered by the model. An
    // explicit prefix still reaches the model throughout. 0 turns it off.
    handoverMinutes: num(process.env.HANDOVER_MINUTES, 30),

    // Hours to behave as though away, without having to remember the command
    // every evening. Two 24-hour times, and it may run past midnight:
    // "22:00-08:00" is the usual shape. Local time, because whoever sets it is
    // thinking in their own hours and the box is theirs. Empty is off.
    quietHours: (process.env.QUIET_HOURS || '').trim(),
    // auto sends the fixed reply through the night, off answers nothing at all.
    quietMode: oneOf(process.env.QUIET_HOURS_MODE, ['auto', 'off'], 'auto'),

    captureIds: bool(process.env.CAPTURE_IDS, false),
    ignoreOlderThanSeconds: num(process.env.IGNORE_OLDER_THAN_SECONDS, 30),

    allowGroups: bool(process.env.ALLOW_GROUPS, false),
    maxRepliesPerHour: num(process.env.MAX_REPLIES_PER_HOUR, 20),

    // How long a conversation has to be quiet before a reply is started.
    //
    // People send a question in two or three parts. Answering the first part
    // the moment it lands means the generation is thrown away when the second
    // arrives, and with MAX_INTERRUPTS at 3 one reply can cost four full
    // generations. Waiting a couple of seconds first absorbs the burst before
    // anything has been spent on it. Measured from their last message, so a
    // question sent whole waits this once and no longer. 0 starts immediately.
    replyDebounceMs: num(process.env.REPLY_DEBOUNCE_MS, 2000),

    // Shows "typing..." while a reply is being written. It makes nothing
    // faster. A minute of silence reads as a number that is broken, and the
    // same minute with this on reads as somebody composing a message.
    typingIndicator: bool(process.env.TYPING_INDICATOR, true),

    // How many times a reply may be thrown away and written again because the
    // sender added something. Zero answers each message separately.
    maxInterrupts: num(process.env.MAX_INTERRUPTS, 3),

    // Added when somebody sends an attachment with no caption. Nothing here can
    // read an image or listen to a voice note, and saying so is better than the
    // silence they used to get, which looked like the number being dead. {what}
    // becomes "a voice note", "an image" and so on. An empty string leaves them
    // the fixed reply on its own.
    // Worded as a policy rather than as an apology. "Unable to process voice
    // notes" is what a business number says; "that came through as a voice
    // note, which could not be read" is what a machine says about itself, and
    // the second is the one that tells everybody what they are talking to.
    mediaNotice:
      process.env.MEDIA_NOTICE === undefined
        ? 'Unable to process {what}. Please send text only.'
        : process.env.MEDIA_NOTICE,

    // Sent once when a conversation hits the cap, so the silence that follows is
    // explained rather than mysterious. An empty string sends nothing.
    rateLimitNotice:
      process.env.RATE_LIMIT_NOTICE === undefined
        ? 'That is as many automatic replies as this number sends in an hour. ' +
          'Your messages are still coming through and will be read.'
        : process.env.RATE_LIMIT_NOTICE,
  },

  // Settings changed by command rather than by editing this file. Kept apart
  // from the away state so that the two writers never share a file, and apart
  // from .env so that clearing one puts it back rather than leaving a second
  // silent copy of the configuration nobody remembers is there.
  settings: {
    file: process.env.SETTINGS_FILE === undefined ? '.cache/settings.json' : process.env.SETTINGS_FILE,
  },

  // A single message in a Discord channel, edited in place, that goes green
  // when this is answering and red when it is not. Separate from the n8n
  // webhook because it is a different kind of thing: that one is a stream of
  // events to act on, this is one light to look at.
  discord: {
    // A Discord webhook URL, which can edit messages it sent itself with no bot
    // token and nothing listening on this side. Empty turns it off.
    statusWebhook: (process.env.DISCORD_STATUS_WEBHOOK || '').trim(),
    statusIntervalMs: num(process.env.DISCORD_STATUS_SECONDS, 60) * 1000,
    // The id of the message being edited, kept so a restart edits the one that
    // is already pinned rather than posting a second one nobody has pinned.
    statusFile: process.env.DISCORD_STATUS_FILE || '.cache/discord-status.json',
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
    port: port(process.env.SEND_API_PORT),
    host: process.env.SEND_API_HOST || '127.0.0.1',
    // The digest, not the key, so a copy of .env is not a working credential.
    keyHash: (process.env.SEND_API_KEY_SHA512 || '').trim().toLowerCase(),
    maxPerMinute: num(process.env.SEND_API_MAX_PER_MINUTE, 30),
    // Off by default, so a leaked key can only reach people already allowlisted.
    allowAny: bool(process.env.SEND_API_ALLOW_ANY, false),
  },

  summary: {
    idleMinutes: num(process.env.SUMMARY_IDLE_MINUTES, 5),
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

    // A ceiling on the reply, not a target.
    //
    // It changes nothing about how the model writes: same prompt, same
    // sampling, same first hundred tokens. All it does is refuse to let a reply
    // run on, and generation time is close to linear in tokens produced, so the
    // only replies it costs anything are the ones that had already gone wrong.
    // Well above what any of the bundled personas need, since they all ask for
    // two short lines. A reply that does reach the ceiling is cut back to its
    // last finished sentence rather than sent half written. 0 removes it.
    maxTokens: num(process.env.ASSISTANT_MAX_TOKENS, 400),

    // Whether what the owner sends by hand is kept in the conversation's
    // transcript, which lives in memory only and is never written to disk. On,
    // the model and the briefing know what has already been said. Off, they do
    // not, and a briefing will happily draft a reply to a question the owner
    // answered ten minutes ago.
    recordOwnReplies: bool(process.env.RECORD_OWN_REPLIES, true),

    systemPromptFile: process.env.SYSTEM_PROMPT_FILE || '',
    systemPrompt: process.env.SYSTEM_PROMPT || '',

    aiPrefix: process.env.AI_PREFIX || '[AI]',
    aiPrefixMode: oneOf(process.env.AI_PREFIX_MODE, ['always', 'first', 'never'], 'always'),
  },
};
