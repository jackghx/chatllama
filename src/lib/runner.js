const readline = require('readline');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const { access, send: sendCfg } = require('../config');
const { listModels } = require('./ollama');
const { enabled: webhookEnabled } = require('./webhook');
const { SerialQueue } = require('./queue');
const { RateLimiter } = require('./ratelimit');
const { RuntimeState } = require('./state');
const { runCommand } = require('./commands');
const { Identity } = require('./identity');
const { startSendApi, stopSendApi } = require('./sendapi');

// Long enough for a summary generation to finish. pm2 sends SIGKILL after its
// kill_timeout, which ecosystem.config.js raises to sit above this.
const SHUTDOWN_GRACE_MS = 10000;

let shutdownInstalled = false;

/**
 * Boots a bot against WhatsApp, or against the terminal with --sim.
 *
 * A bot is { name, clientId, startup: string[], handle(id, text, ctx) }
 * where ctx is { isSim, from }. An optional shutdown() is awaited on SIGINT
 * and SIGTERM, for work that would otherwise be lost on restart.
 */
function run(bot) {
  return process.argv.includes('--sim') ? runSim(bot) : runWhatsApp(bot);
}

/**
 * Installed once the run has something worth closing.
 *
 * `closers` is for anything the runner owns rather than the bot, such as a
 * listening socket. It used to install only when the bot had a shutdown of its
 * own, which would have left those open.
 */
function installShutdown(bot, closers = []) {
  const work = [...closers];
  if (typeof bot.shutdown === 'function') work.push(() => bot.shutdown());

  if (shutdownInstalled || !work.length) return;
  shutdownInstalled = true;

  let closing = false;
  const close = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`[${bot.name}] ${signal}, finishing up`);

    const grace = new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS).unref());
    try {
      await Promise.race([Promise.all(work.map((fn) => fn())), grace]);
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

  const consequence = {
    always:
      'every message from anyone who has this number, including people not in ' +
      'your contacts, gets an automated reply.',
    auto:
      'anyone who messages this account gets the fixed reply, and anyone using ' +
      `${access.commandPrefix} gets an answer from the model.`,
    prefix: `anyone who messages this account with ${access.commandPrefix} will get a reply.`,
    off: 'nothing is being answered, which only matters once it is switched back on.',
  }[access.replyMode];

  console.warn(
    `[access] ALLOWED_CONTACTS is empty and REPLY_MODE is ${access.replyMode}, so ${consequence}`
  );
}

/**
 * Whether a message the owner sent went to their own Note to Self chat.
 *
 * Both ends of a self-chat message are you, so comparing the two sides of the
 * same message is enough, and it is the only check that holds on an account
 * WhatsApp has migrated to linked IDs. client.info.wid is whichever form the
 * page reports, preferring the phone number, while the chat itself may be
 * identified by the @lid form. Comparing against wid alone then never matches,
 * and every command is dropped as not-self.
 */
function isSelfChat(msg, runtime) {
  const from = String(msg.from || '');
  const to = String(msg.to || '');

  if (from && to && from === to) return true;
  return Boolean(runtime.selfChat) && to === runtime.selfChat;
}

/**
 * Works out what a message is for, without doing anything about it.
 *
 * Pure on purpose. This used to spend the sender's hourly allowance and log as
 * it went, which meant the decision and its consequences could not be told
 * apart, and a message that was only amending a reply already being written
 * still had to be routed around the rate limiter by its caller. Now the caller
 * charges the limit, and only for messages that will produce a reply of their
 * own.
 *
 * Handles both directions. A message the owner sent is one the owner may be
 * steering the bot with, and it arrives on a different event, but it shares the
 * filters above: written as a second function, the backlog check gets left out
 * of one of them, and then a replayed "/ai off" from three days ago switches
 * the bot off again on every restart.
 *
 * Returns one of:
 *   { kind: 'ignore',  chatId, reason }
 *   { kind: 'model',   chatId, text }
 *   { kind: 'auto',    chatId, text }
 *   { kind: 'command', chatId, text }
 */
function classify(msg, runtime, { simulated = false, identity = null } = {}) {
  const fromMe = Boolean(msg.fromMe);
  // For a message the owner sent, the conversation is who it went to.
  const chatId = String((fromMe ? msg.to : msg.from) || '');
  const ignore = (reason) => ({ kind: 'ignore', chatId, reason });

  // Everything about who is writing has no meaning at a terminal. The
  // simulation skips it and exercises the modes only, rather than answering
  // everything regardless of them as it used to.
  if (!simulated) {
    // whatsapp-web.js replays recent history on connect.
    if (Date.now() / 1000 - msg.timestamp > access.ignoreOlderThanSeconds) return ignore('backlog');
    if (chatId.endsWith('@broadcast')) return ignore('broadcast');
  }

  // Images, stickers, voice notes and system events arrive with no body.
  // A captioned image carries its caption, and is answered on that.
  const body = (msg.body || '').trim();

  if (fromMe) {
    if (access.ownerCommands === 'off') return ignore('commands-off');
    if (access.ownerCommands === 'self' && !isSelfChat(msg, runtime)) return ignore('not-self');

    // Regardless of ALLOW_GROUPS. An acknowledgement in a group is visible to
    // everyone in it, which is not what anyone means by a private control.
    if (chatId.endsWith('@g.us')) return ignore('group');
    if (!body) return ignore('empty');

    const text = stripPrefix(body, access.commandPrefix);
    if (text === null) return ignore('not-a-command');
    return { kind: 'command', chatId, text };
  }

  if (!simulated) {
    // The @g.us suffix is the only thing marking a group on this event.
    if (chatId.endsWith('@g.us') && !access.allowGroups) return ignore('group');

    // Capture mode runs before the allowlist so it sees everyone, and answers
    // nobody, which keeps the account quiet while the list is being collected.
    if (access.captureIds) return ignore('capture');

    // Never falls open. A resolution that failed leaves the configured numbers
    // matching nothing but their phone-number form, which is a bot that answers
    // too few people rather than one that answers strangers.
    if (identity && !identity.allows(chatId)) return ignore('not-allowed');
  }

  const mode = runtime.effectiveMode();

  // Checked after the allowlist and after capture, so that switching the bot
  // off silences it without also blinding the diagnostics.
  if (mode === 'off') return ignore('off');
  if (!body) return ignore('empty');

  // always is the only mode where a bare message reaches the model.
  if (mode === 'always') return { kind: 'model', chatId, text: body };

  const text = stripPrefix(body, access.commandPrefix);
  if (text) return { kind: 'model', chatId, text };

  // Everything that is not a command gets the fixed reply instead, which is the
  // whole point of auto mode: instant, and it cannot say anything wrong. With
  // no text configured there is nothing to send, so it behaves as prefix mode.
  if (mode === 'auto' && (runtime.awayText || access.autoReplyText)) {
    return { kind: 'auto', chatId, text: body };
  }

  return ignore('no-match');
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
  const runtime = new RuntimeState({
    mode: access.replyMode,
    autoGapMs: access.autoReplyGapMinutes * 60 * 1000,
    autoMaxPerDay: access.autoReplyMaxPerDay,
  });

  // Built before connecting, so whatever was cached from last time is in place
  // by the time the first message can arrive.
  const identity = new Identity({
    entries: access.allowedContacts,
    cacheFile: access.contactCacheFile,
    ttlDays: access.contactCacheTtlDays,
    delayMs: access.contactResolveDelayMs,
  });

  client.on('qr', (qr) => {
    console.log('[auth] scan this QR code with WhatsApp:');
    qrcode.generate(qr, { small: true });
  });

  client.on('auth_failure', (m) => console.error('[auth] failed:', m));
  client.on('disconnected', (r) => console.error('[auth] disconnected:', r));

  client.on('ready', async () => {
    // The chat with yourself, which is where owner commands are read from
    // unless OWNER_COMMANDS says otherwise.
    runtime.selfChat = (client.info && client.info.wid && client.info.wid._serialized) || null;

    console.log(`[${bot.name}] ready, reply mode: ${runtime.effectiveMode()}`);
    console.log(
      `[commands] ${
        {
          off: 'off',
          self: `${access.commandPrefix} from your own chat only, ${runtime.selfChat || 'own ID unknown'}`,
          any: `${access.commandPrefix} from any chat you send from`,
        }[access.ownerCommands]
      }`
    );
    await preflight(bot);

    await identity.resolve(client);
    for (const line of identity.report()) console.log(line);

    reportAccess();
  });

  /**
   * Everything the bot sends goes through here.
   *
   * WhatsApp reports the bot's own messages back on message_create, the same
   * event that carries the owner typing a command. Remembering the IDs is what
   * stops a reply that happens to begin with the command prefix being read back
   * as an instruction, which is a loop rather than a mistake.
   */
  async function send(chatId, body) {
    const res = await client.sendMessage(chatId, body);
    const id = res && res.id && res.id._serialized;
    if (id) runtime.noteSelfSent(id);
    return res;
  }

  /**
   * Writes one reply, starting again whenever a newer message is added.
   *
   * The abort lands inside generate(), so the discarded attempt costs only the
   * seconds it had already run, and nothing reaches memory or the sender.
   */
  async function answer(chatId, state) {
    for (;;) {
      // Read here rather than trusted from the moment this was queued. A reply
      // can sit behind a long generation, and by the time it runs the
      // conversation may have been called off.
      if (state.cancelled) {
        console.log(`[${bot.name}] .. ${chatId}: dropped, ${state.cancelled}`);
        return;
      }

      state.controller = new AbortController();

      let reply;
      try {
        reply = await bot.handle(chatId, state.parts.join('\n'), {
          isSim: false,
          from: chatId,
          signal: state.controller.signal,
        });
      } catch (err) {
        // Either an amendment, which loops round with more to go on, or a
        // cancellation, which the check at the top of the loop turns into a
        // stop. Without that check this would regenerate the same text forever.
        if (err.name === 'Aborted') continue;
        throw err;
      }

      // Checked again: a cancellation can land while the model is finishing, in
      // which case aborting the finished request did nothing.
      if (state.cancelled) {
        console.log(`[${bot.name}] .. ${chatId}: written but dropped, ${state.cancelled}`);
        return;
      }

      // Cleared before sending, not after: a message arriving during the send
      // has nothing left to amend and should start a reply of its own.
      if (runtime.writing.get(chatId) === state) runtime.writing.delete(chatId);

      await send(chatId, reply);
      console.log(`[${bot.name}] -> ${chatId}: ${reply.slice(0, 120)}`);
      return;
    }
  }

  /**
   * Spends one of the conversation's hourly replies, or explains why it cannot.
   *
   * The notice is queued rather than sent inline, so it lands after any reply
   * already being written for this conversation rather than in front of it.
   */
  function affordable(chatId) {
    if (limiter.allow(chatId)) return true;

    if (limiter.firstBreach(chatId)) {
      console.warn(
        `[limit] ${chatId} hit ${access.maxRepliesPerHour} replies in an hour, ` +
          'pausing this conversation. Raise MAX_REPLIES_PER_HOUR if this is wrong.'
      );
      if (access.rateLimitNotice) {
        queue.push(async () => {
          await send(chatId, access.rateLimitNotice);
          console.log(`[limit] told ${chatId} that automatic replies have paused`);
        });
      }
    }
    return false;
  }

  client.on('message', (msg) => {
    const decision = classify(msg, runtime, { identity });
    const { chatId } = decision;

    if (decision.kind === 'ignore') {
      // Once per sender, because the same person messaging five times is the
      // same one line. It reports whether the ID matched, which since the
      // numbers resolve themselves is the only question left: not "what do I
      // paste in" but "why is this person being ignored".
      if (decision.reason === 'capture' && !runtime.captured.has(chatId)) {
        runtime.captured.add(chatId);
        console.log('[capture]', chatId, identity.allows(chatId) ? 'allowed' : 'not allowed');
      }
      return;
    }

    const live = runtime.writing.get(chatId);
    // autoText so that "away 2h in a meeting" overrides the configured wording
    // without the bot having to read runtime state it does not own.
    const ctx = {
      isSim: false,
      from: chatId,
      autoText: runtime.awayText || access.autoReplyText,
    };

    // Worked out before the timestamp moves, because the gap is measured from
    // their last message. A plain message arriving while a reply is already
    // being written never gets the fixed line: it would land in the middle of
    // an answer being written for that same person. Dropping it is consistent,
    // since in auto mode it was never going to reach the model anyway.
    const due = decision.kind === 'auto' && !live && runtime.shouldAutoReply(chatId);
    runtime.noteInbound(chatId);

    console.log(`[${bot.name}] <- ${chatId}: ${decision.text}`);

    if (decision.kind === 'auto') {
      // Recorded either way, so the briefing covers everything they sent rather
      // than only the message that happened to earn a reply. Without this, a
      // conversation the fixed reply handled would reach you as silence.
      if (!due) {
        if (bot.observe) bot.observe(chatId, decision.text, ctx);
        return;
      }

      runtime.noteAutoReply(chatId);
      queue.push(async () => {
        const reply = bot.auto ? bot.auto(chatId, decision.text, ctx) : ctx.autoText;
        if (!reply) return;
        await send(chatId, reply);
        console.log(`[${bot.name}] => ${chatId}: ${reply.slice(0, 120)}`);
      });
      return;
    }

    const amending = Boolean(live) && live.restarts < access.maxInterrupts;

    // An amendment produces no reply of its own, so it has nothing to charge
    // against the hourly cap: two messages, one answer, one slot.
    if (!amending && !affordable(chatId)) return;

    if (amending) {
      live.parts.push(decision.text);
      // No controller yet means the reply has not started, so the added line is
      // already picked up and there is nothing to interrupt.
      if (live.controller) {
        live.restarts += 1;
        live.controller.abort();
        console.log(`[${bot.name}] .. ${chatId}: amended, writing it again`);
      }
      return;
    }

    const state = { parts: [decision.text], restarts: 0, controller: null, cancelled: null };
    runtime.writing.set(chatId, state);

    queue.push(async () => {
      try {
        await answer(chatId, state);
      } finally {
        if (runtime.writing.get(chatId) === state) runtime.writing.delete(chatId);
      }
    });
  });

  client.on('message_create', (msg) => {
    // Inbound messages arrive on this event as well, ahead of 'message', so
    // without this every reply, every rate-limit charge and every fixed reply
    // would happen twice.
    if (!msg.fromMe) return;

    const id = msg.id && msg.id._serialized;
    if (id && runtime.selfSent.has(id)) return;

    const decision = classify(msg, runtime);
    if (decision.kind !== 'command') {
      // Quiet for ordinary messages you send people, loud for one that was
      // meant to be a command and was not read as one. Without this a dropped
      // command looks exactly like a handler that never fired, and there is
      // nothing to go on.
      if (stripPrefix((msg.body || '').trim(), access.commandPrefix) !== null) {
        console.log(
          `[${bot.name}] command from ${decision.chatId} ignored: ${decision.reason}`
        );
      }
      return;
    }

    const reply = runCommand(runtime, decision.text, {
      cancelAll: (reason) => {
        for (const chat of [...runtime.writing.keys()]) runtime.cancel(chat, reason);
      },
    });

    console.log(`[${bot.name}] command "${decision.text || 'status'}": ${reply}`);
    if (!access.ownerCommandAck) return;

    queue.push(() => send(decision.chatId, reply));
  });

  const server = startSendApi({
    port: sendCfg.port,
    host: sendCfg.host,
    keyHash: sendCfg.keyHash,
    maxPerMinute: sendCfg.maxPerMinute,
    allows: (to) => sendCfg.allowAny || identity.allows(to),
    deliver: (to, text) => {
      // A reply you approved replaces whatever the model was in the middle of
      // writing for that conversation, rather than arriving alongside it.
      if (runtime.cancel(to, 'sent by hand')) {
        console.log(`[send] dropped the reply being written for ${to}`);
      }
      queue.push(async () => {
        await send(to, text);
        console.log(`[send] -> ${to}: ${text.slice(0, 120)}`);
      });
    },
  });

  installShutdown(bot, server ? [() => stopSendApi(server)] : []);
  client.initialize();
  return { client, runtime, identity, queue, server };
}

async function runSim(bot) {
  console.log(`--- ${bot.name}: terminal simulation, reply mode: ${access.replyMode} ---`);
  if (!(await preflight(bot))) process.exit(1);
  installShutdown(bot);
  console.log('Type a message and press enter. Ctrl+C to exit.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const queue = new SerialQueue(bot.name);
  const runtime = new RuntimeState({
    mode: access.replyMode,
    autoGapMs: access.autoReplyGapMinutes * 60 * 1000,
    autoMaxPerDay: access.autoReplyMaxPerDay,
  });

  const ctx = { isSim: true, from: null };

  const ask = () => {
    rl.question('you: ', (input) => {
      const text = input.trim();
      if (!text) return ask();

      const decision = classify(
        { from: 'sim', body: text, timestamp: Math.floor(Date.now() / 1000) },
        runtime,
        { simulated: true }
      );

      if (decision.kind === 'ignore') {
        console.log(`(nothing sent: ${decision.reason})\n`);
        return ask();
      }

      if (decision.kind === 'auto') {
        const due = runtime.shouldAutoReply('sim');
        runtime.noteInbound('sim');

        if (!due) {
          if (bot.observe) bot.observe('sim', decision.text, ctx);
          console.log('(nothing sent: they have had the fixed reply recently)\n');
          return ask();
        }

        runtime.noteAutoReply('sim');
        console.log(`${bot.auto ? bot.auto('sim', decision.text, ctx) : access.autoReplyText}\n`);
        return ask();
      }

      runtime.noteInbound('sim');
      queue.push(async () => {
        const reply = await bot.handle('sim', decision.text, ctx);
        console.log(`${reply}\n`);
        ask();
      });
    });
  };

  ask();
}

module.exports = { run, classify };
