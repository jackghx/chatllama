const readline = require('readline');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const { access } = require('../config');
const { listModels } = require('./ollama');
const { enabled: webhookEnabled } = require('./webhook');
const { SerialQueue } = require('./queue');
const { RateLimiter } = require('./ratelimit');

/**
 * Boots a bot definition either against WhatsApp or in terminal
 * simulation mode (`--sim`), so behaviour can be tested without
 * involving another person.
 *
 * A bot definition is:
 *   {
 *     name:      string,
 *     clientId:  string,                  // keeps sessions separate per bot
 *     startup:   string[],                // lines to log once, at startup
 *     handle:    async (conversationId, text, ctx) => string
 *   }
 *
 * ctx is { isSim: boolean, from: string|null }
 */
function run(bot) {
  const isSim = process.argv.includes('--sim');
  return isSim ? runSim(bot) : runWhatsApp(bot);
}

async function preflight(bot) {
  for (const line of bot.startup || []) console.log(line);

  // notify() returns early when the URL is empty, silently. Without this line
  // an empty or mistyped N8N_WEBHOOK_URL looks identical to a working one from
  // the bot's side: nothing ever arrives in Discord and nothing says why.
  console.log(
    webhookEnabled()
      ? '[webhook] logging on'
      : '[webhook] logging off, N8N_WEBHOOK_URL is empty'
  );

  try {
    const models = await listModels();
    console.log('[ollama] reachable. models:', models.join(', ') || '(none)');
    return true;
  } catch (err) {
    console.error('[ollama] unreachable:', err.message);
    console.error('[ollama] check OLLAMA_HOST, the port, and that the model is pulled.');
    return false;
  }
}

function isAllowed(from) {
  if (!access.allowedContacts.length) return true;
  return access.allowedContacts.includes(from);
}

/**
 * Group chats and status broadcasts, which are not one to one conversations.
 *
 * whatsapp-web.js delivers both. In prefix mode they were mostly harmless,
 * since a human had to type the prefix. Replying to everything makes a group
 * the worst case this project has: every member's every message answered.
 */
const isGroup = (chatId) => String(chatId).endsWith('@g.us');
const isBroadcast = (chatId) => String(chatId).endsWith('@broadcast');

/**
 * Strip the command prefix from a message body. Used in prefix mode only.
 *
 * Returns the remaining text, or null when the message is not a command.
 * A plain startsWith is not enough: with a prefix of "/ai", the message
 * "/airplanes are loud" passes and gets sliced into "rplanes are loud".
 * So the prefix must be followed by whitespace or by nothing at all.
 *
 * That boundary only applies when the prefix ends in a word character.
 * A prefix of "!" is meant to be written as "!question", with no space.
 */
function stripPrefix(body, prefix) {
  if (body.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return null;

  const rest = body.slice(prefix.length);
  if (rest && /\w$/.test(prefix) && !/^\s/.test(rest)) return null;

  return rest.trim();
}

function warnOnOpenAllowlist() {
  if (access.allowedContacts.length) return;

  if (access.replyMode === 'always') {
    console.warn(
      '[access] ALLOWED_CONTACTS is empty and REPLY_MODE is always, so every ' +
        'message from anyone who has this number, including people not in your ' +
        'contacts, gets an automated reply.'
    );
    return;
  }

  console.warn(
    '[access] ALLOWED_CONTACTS is empty, so anyone who messages this ' +
      'account with the command prefix will get a reply.'
  );
}

function runWhatsApp(bot) {
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: bot.clientId }),
    puppeteer: {
      headless: true,
      // Required when running as root inside an unprivileged container.
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });

  const queue = new SerialQueue(bot.name);
  const limiter = new RateLimiter(access.maxRepliesPerHour);

  client.on('qr', (qr) => {
    console.log('[auth] scan this QR code with WhatsApp:');
    qrcode.generate(qr, { small: true });
  });

  client.on('auth_failure', (m) => console.error('[auth] failed:', m));
  client.on('disconnected', (r) => console.error('[auth] disconnected:', r));

  client.on('ready', async () => {
    console.log(`[${bot.name}] ready, reply mode: ${access.replyMode}`);
    await preflight(bot);
    warnOnOpenAllowlist();
  });

  client.on('message', (msg) => {
    // whatsapp-web.js replays recent history on connect. Without this the
    // bot answers the entire backlog every time it restarts.
    const ageSeconds = Date.now() / 1000 - msg.timestamp;
    if (ageSeconds > access.ignoreOlderThanSeconds) return;

    const chatId = msg.from;

    if (isBroadcast(chatId)) return;
    if (isGroup(chatId) && !access.allowGroups) return;

    if (!isAllowed(chatId)) {
      if (access.logUnmatched) console.log('[access] unmatched sender:', chatId);
      return;
    }

    // Images, stickers, voice notes and system events arrive with no body.
    // A captioned image does carry its caption here, and is answered on that.
    const body = (msg.body || '').trim();
    if (!body) return;

    const text = access.replyMode === 'prefix' ? stripPrefix(body, access.commandPrefix) : body;
    if (!text) return;

    if (!limiter.allow(chatId)) {
      if (limiter.firstBreach(chatId)) {
        console.warn(
          `[limit] ${chatId} hit ${access.maxRepliesPerHour} replies in an hour, ` +
            'pausing this conversation. Raise MAX_REPLIES_PER_HOUR if this is wrong.'
        );
      }
      return;
    }

    console.log(`[${bot.name}] <- ${chatId}: ${text}`);

    queue.push(async () => {
      const reply = await bot.handle(chatId, text, { isSim: false, from: chatId });
      await client.sendMessage(chatId, reply);
      console.log(`[${bot.name}] -> ${chatId}: ${reply.slice(0, 120)}`);
    });
  });

  client.initialize();
  return client;
}

async function runSim(bot) {
  console.log(`--- ${bot.name}: terminal simulation, reply mode: ${access.replyMode} ---`);
  const ok = await preflight(bot);
  if (!ok) process.exit(1);
  console.log('Type a message and press enter. Ctrl+C to exit.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const conversationId = 'sim';
  const queue = new SerialQueue(bot.name);

  const ask = () => {
    rl.question('you: ', (input) => {
      const text = input.trim();
      if (!text) return ask();
      queue.push(async () => {
        const reply = await bot.handle(conversationId, text, { isSim: true, from: null });
        console.log(reply);
        console.log('');
        ask();
      });
    });
  };

  if (bot.simOpener) {
    queue.push(async () => {
      const reply = await bot.handle(conversationId, bot.simOpener, {
        isSim: true,
        from: null,
      });
      console.log(reply);
      console.log('');
      ask();
    });
  } else {
    ask();
  }
}

module.exports = { run };
