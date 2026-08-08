const readline = require('readline');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const { access } = require('../config');
const { listModels } = require('./ollama');
const { enabled: webhookEnabled } = require('./webhook');
const { SerialQueue } = require('./queue');
const { RateLimiter } = require('./ratelimit');

// Long enough for a summary generation to finish. pm2 sends SIGKILL after its
// kill_timeout, which ecosystem.config.js raises to sit above this.
const SHUTDOWN_GRACE_MS = 10000;

let shutdownInstalled = false;

// Senders already printed in capture mode, so the log is a list to paste rather
// than a running commentary.
const captured = new Set();

/**
 * Boots a bot against WhatsApp, or against the terminal with --sim.
 *
 * A bot is { name, clientId, startup: string[], handle(id, text, ctx) }
 * where ctx is { isSim, from }. An optional shutdown() is awaited on SIGINT
 * and SIGTERM, for work that would otherwise be lost on restart.
 */
function run(bot) {
  installShutdown(bot);
  return process.argv.includes('--sim') ? runSim(bot) : runWhatsApp(bot);
}

function installShutdown(bot) {
  if (shutdownInstalled || typeof bot.shutdown !== 'function') return;
  shutdownInstalled = true;

  let closing = false;
  const close = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`[${bot.name}] ${signal}, finishing up`);

    const grace = new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS).unref());
    try {
      await Promise.race([bot.shutdown(), grace]);
    } catch (err) {
      console.error(`[${bot.name}] shutdown failed:`, err.message);
    }
    process.exit(0);
  };

  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => close(signal));
}

async function preflight(bot) {
  for (const line of bot.startup || []) console.log(line);

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

/**
 * Returns the text after the prefix, or null if the message is not a command.
 *
 * startsWith alone would match "/airplanes are loud" against a "/ai" prefix and
 * slice it into "rplanes are loud", so the prefix has to end on a boundary.
 * Prefixes not ending in a word character, like "!", are written "!question"
 * with no space, and are exempt.
 */
function stripPrefix(body, prefix) {
  if (body.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return null;

  const rest = body.slice(prefix.length);
  if (rest && /\w$/.test(prefix) && !/^\s/.test(rest)) return null;

  return rest.trim();
}

function reportAccess() {
  if (access.captureIds) {
    console.log(
      '[capture] on, logging sender IDs and answering nobody. Turn it off ' +
        'once ALLOWED_CONTACTS is filled in.'
    );
    return;
  }

  if (access.allowedContacts.length) return;

  console.warn(
    access.replyMode === 'always'
      ? '[access] ALLOWED_CONTACTS is empty and REPLY_MODE is always, so every ' +
          'message from anyone who has this number, including people not in ' +
          'your contacts, gets an automated reply.'
      : '[access] ALLOWED_CONTACTS is empty, so anyone who messages this ' +
          'account with the command prefix will get a reply.'
  );
}

function accepts(msg, limiter) {
  const chatId = msg.from;

  // whatsapp-web.js replays recent history on connect.
  if (Date.now() / 1000 - msg.timestamp > access.ignoreOlderThanSeconds) return null;

  // The @g.us suffix is the only thing marking a group on this event.
  if (chatId.endsWith('@broadcast')) return null;
  if (chatId.endsWith('@g.us') && !access.allowGroups) return null;

  // Capture mode is how the @lid values for ALLOWED_CONTACTS are found. It runs
  // before the allowlist so it sees everyone, and answers nobody, which keeps
  // the account quiet while the list is being collected. Once per sender,
  // because the same person messaging five times is the same one line.
  if (access.captureIds) {
    if (!captured.has(chatId)) {
      captured.add(chatId);
      console.log('[capture]', chatId);
    }
    return null;
  }

  if (access.allowedContacts.length && !access.allowedContacts.includes(chatId)) return null;

  // Images, stickers, voice notes and system events arrive with no body.
  // A captioned image carries its caption, and is answered on that.
  const body = (msg.body || '').trim();
  if (!body) return null;

  const text = access.replyMode === 'prefix' ? stripPrefix(body, access.commandPrefix) : body;
  if (!text) return null;

  if (!limiter.allow(chatId)) {
    if (limiter.firstBreach(chatId)) {
      console.warn(
        `[limit] ${chatId} hit ${access.maxRepliesPerHour} replies in an hour, ` +
          'pausing this conversation. Raise MAX_REPLIES_PER_HOUR if this is wrong.'
      );
    }
    return null;
  }

  return text;
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
    reportAccess();
  });

  client.on('message', (msg) => {
    const text = accepts(msg, limiter);
    if (!text) return;

    const chatId = msg.from;
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
  if (!(await preflight(bot))) process.exit(1);
  console.log('Type a message and press enter. Ctrl+C to exit.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const queue = new SerialQueue(bot.name);

  const ask = () => {
    rl.question('you: ', (input) => {
      const text = input.trim();
      if (!text) return ask();
      queue.push(async () => {
        const reply = await bot.handle('sim', text, { isSim: true, from: null });
        console.log(`${reply}\n`);
        ask();
      });
    });
  };

  ask();
}

module.exports = { run };
