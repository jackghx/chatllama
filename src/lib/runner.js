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

// A null limiter means this message will not produce a reply of its own, so it
// has nothing to charge against the hourly cap. onLimit fires once per breach,
// for telling the sender why they are about to be ignored.
function accepts(msg, limiter, onLimit) {
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

  if (limiter && !limiter.allow(chatId)) {
    if (limiter.firstBreach(chatId)) {
      console.warn(
        `[limit] ${chatId} hit ${access.maxRepliesPerHour} replies in an hour, ` +
          'pausing this conversation. Raise MAX_REPLIES_PER_HOUR if this is wrong.'
      );
      if (onLimit) onLimit(chatId);
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

  // Conversations with a reply currently being written. Someone who corrects
  // themselves mid-sentence should get one answer to the whole thing, not an
  // answer to the half they have already taken back.
  const writing = new Map();

  /**
   * Writes one reply, starting again whenever a newer message is added.
   *
   * The abort lands inside generate(), so the discarded attempt costs only the
   * seconds it had already run, and nothing reaches memory or the sender.
   */
  async function answer(chatId, state) {
    for (;;) {
      state.controller = new AbortController();

      let reply;
      try {
        reply = await bot.handle(chatId, state.parts.join('\n'), {
          isSim: false,
          from: chatId,
          signal: state.controller.signal,
        });
      } catch (err) {
        if (err.name === 'Aborted') continue;
        throw err;
      }

      // Cleared before sending, not after: a message arriving during the send
      // has nothing left to amend and should start a reply of its own.
      if (writing.get(chatId) === state) writing.delete(chatId);

      await client.sendMessage(chatId, reply);
      console.log(`[${bot.name}] -> ${chatId}: ${reply.slice(0, 120)}`);
      return;
    }
  }

  client.on('message', (msg) => {
    const chatId = msg.from;
    const live = writing.get(chatId);
    const amending = Boolean(live) && live.restarts < access.maxInterrupts;

    // Queued rather than sent inline, so it lands after any reply already being
    // written for this conversation rather than jumping in front of it.
    const text = accepts(msg, amending ? null : limiter, (id) => {
      if (!access.rateLimitNotice) return;
      queue.push(async () => {
        await client.sendMessage(id, access.rateLimitNotice);
        console.log(`[limit] told ${id} that automatic replies have paused`);
      });
    });
    if (!text) return;

    console.log(`[${bot.name}] <- ${chatId}: ${text}`);

    if (amending) {
      live.parts.push(text);
      // No controller yet means the reply has not started, so the added line is
      // already picked up and there is nothing to interrupt.
      if (live.controller) {
        live.restarts += 1;
        live.controller.abort();
        console.log(`[${bot.name}] .. ${chatId}: amended, writing it again`);
      }
      return;
    }

    const state = { parts: [text], restarts: 0, controller: null };
    writing.set(chatId, state);

    queue.push(async () => {
      try {
        await answer(chatId, state);
      } finally {
        if (writing.get(chatId) === state) writing.delete(chatId);
      }
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
