const readline = require('readline');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const { access, send: sendCfg } = require('../config');
const { listModels } = require('./ollama');
const { enabled: webhookEnabled } = require('./webhook');
const { SerialQueue } = require('./queue');
const { RateLimiter } = require('./ratelimit');
const { RuntimeState } = require('./state');
const { runCommand, isCommand } = require('./commands');
const { Identity } = require('./identity');
const { startSendApi, stopSendApi } = require('./sendapi');

// Long enough for a summary generation to finish. pm2 sends SIGKILL after its
// kill_timeout, which ecosystem.config.js raises to sit above this.
const SHUTDOWN_GRACE_MS = 10000;

// WhatsApp drops the typing state on its own after roughly twenty-five seconds,
// so it has to be sent again while a long generation is still running.
const TYPING_REFRESH_MS = 20000;

// A ceiling on the debounce, as a multiple of it. Somebody typing steadily
// would otherwise defer their own answer for as long as they kept going.
const MAX_DEBOUNCE_MULTIPLE = 3;

// One model, however many people are writing in, so warming it for each of them
// would be the same load requested over and over.
const WARM_THROTTLE_MS = 60000;

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

/**
 * The fixed reply as it goes out, with the away reason under it.
 *
 * The configured wording is what tells people how to reach the model, so a
 * reason replacing it costs them that. Underneath, both survive: what to do,
 * and why nobody is there.
 */
function autoReply(runtime) {
  const fixed = access.autoReplyText;
  const reason = runtime.awayText;

  if (!reason) return fixed;
  if (!fixed) return reason;
  return `${fixed}\n\nReason: ${reason}`;
}

/**
 * Shows "typing..." for as long as a reply is being written.
 *
 * Nothing here is any faster for it. A model that takes most of a minute reads
 * as a number that has stopped working, and the identical wait with this on
 * reads as somebody composing a message, which is the more honest of the two
 * given that a message is in fact being composed.
 *
 * Every failure is swallowed on purpose. This is decoration, and a chat that
 * cannot be fetched must never be the reason somebody loses their reply.
 */
function startTyping(client, chatId) {
  if (!access.typingIndicator || typeof client.getChatById !== 'function') return () => {};

  let chat = null;
  let stopped = false;

  const tick = async () => {
    try {
      if (!chat) chat = await client.getChatById(chatId);
      if (stopped || !chat) return;
      await chat.sendStateTyping();
    } catch {
      // Deliberately ignored. See above.
    }
  };

  tick();
  const timer = setInterval(tick, TYPING_REFRESH_MS).unref();

  return () => {
    stopped = true;
    clearInterval(timer);
    // Cleared even though sending a message clears it too, because a reply that
    // was cancelled or dropped never sends one and would otherwise leave the
    // chat showing "typing..." until WhatsApp timed it out.
    Promise.resolve()
      .then(() => chat && chat.clearState())
      .catch(() => {});
  };
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
 * Two tests because neither covers it alone. Where both ends of the message are
 * the same identifier, that settles it. Where they are not, the account is one
 * WhatsApp has migrated: client.info.wid and the message's own from are the
 * phone number, while the chat is keyed by the linked ID, and nothing on the
 * message connects the two. That is why the owner's IDs are resolved on ready
 * and matched as a set.
 */
function isSelfChat(msg, runtime) {
  const from = String(msg.from || '');
  const to = String(msg.to || '');

  if (from && to && from === to) return true;
  return runtime.isSelfChat(to);
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

  // Somebody already talking to the model stays talking to it. Asking for the
  // prefix on every message means the second half of a question gets the fixed
  // reply and has to be typed again, which is what people actually do.
  if (runtime.isEngaged(chatId)) return { kind: 'model', chatId, text: body };

  // Everything that is not a command gets the fixed reply instead, which is the
  // whole point of auto mode: instant, and it cannot say anything wrong. With
  // no text configured there is nothing to send, so it behaves as prefix mode.
  if (mode === 'auto' && (runtime.awayText || access.autoReplyText)) {
    return { kind: 'auto', chatId, text: body };
  }

  return ignore('no-match');
}

/**
 * Adds the linked-ID form of the owner's own account to the set of chats
 * commands are accepted from.
 *
 * WhatsApp reports the account as a phone number but keys the chat with
 * yourself by its linked ID, so without this every command sent from your own
 * phone is dropped as not-self, silently until the log line was added. The same
 * lookup the allowlist uses, on one ID, which is the only direction that works.
 */
async function resolveOwnIds(client, runtime) {
  if (access.ownerCommands !== 'self') return;
  if (!runtime.selfChat || typeof client.getContactLidAndPhone !== 'function') return;

  try {
    const [row] = await client.getContactLidAndPhone([runtime.selfChat]);
    // Both, because which one keys the chat is not something to guess at, and
    // they are the account's own identifiers either way.
    if (row && row.lid) runtime.addSelfChat(row.lid);
    if (row && row.pn) runtime.addSelfChat(row.pn);
  } catch (err) {
    console.warn(
      `[commands] could not resolve this account's other identifier: ${err.message}. ` +
        'If commands from your own chat are ignored, set OWNER_COMMANDS=any.'
    );
  }
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
    followUpMs: access.followUpMinutes * 60 * 1000,
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
    runtime.addSelfChat((client.info && client.info.wid && client.info.wid._serialized) || null);
    await resolveOwnIds(client, runtime);

    console.log(`[${bot.name}] ready, reply mode: ${runtime.effectiveMode()}`);
    console.log(
      `[commands] ${
        {
          off: 'off',
          self:
            `${access.commandPrefix} from your own chat only, ` +
            `${[...runtime.selfChats].join(' and ') || 'own ID unknown'}`,
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
   * Holds a reply back until the sender has stopped adding to it.
   *
   * Interrupting a generation already under way works, but the seconds it had
   * run are gone. Almost every interruption is somebody sending a question in
   * two or three parts within a few seconds, which is a burst that can be
   * waited out before anything has been spent at all.
   *
   * Returns false if the conversation was called off while waiting.
   */
  async function settleInput(chatId, state) {
    const debounce = access.replyDebounceMs;
    if (debounce <= 0) return !state.cancelled;

    const deadline = Date.now() + debounce * MAX_DEBOUNCE_MULTIPLE;

    state.debouncing = true;
    try {
      for (;;) {
        const quiet = Date.now() - state.lastPart;
        const left = Math.min(debounce - quiet, deadline - Date.now());
        if (left <= 0) return true;

        // unref, so a reply waiting out a burst is never the only thing holding
        // the process open during a shutdown.
        await new Promise((resolve) => setTimeout(resolve, left).unref());

        if (state.cancelled) {
          console.log(`[${bot.name}] .. ${chatId}: dropped while waiting, ${state.cancelled}`);
          return false;
        }
      }
    } finally {
      state.debouncing = false;
    }
  }

  /**
   * Writes one reply, starting again whenever a newer message is added.
   *
   * The abort lands inside generate(), so the discarded attempt costs only the
   * seconds it had already run, and nothing reaches memory or the sender.
   */
  async function answer(chatId, state) {
    // Started before the debounce rather than after. They are mid-conversation
    // from the moment their message lands, and the wait is part of the reply.
    const stopTyping = startTyping(client, chatId);
    try {
      return await write(chatId, state);
    } finally {
      stopTyping();
    }
  }

  async function write(chatId, state) {
    for (;;) {
      // Read here rather than trusted from the moment this was queued. A reply
      // can sit behind a long generation, and by the time it runs the
      // conversation may have been called off.
      if (state.cancelled) {
        console.log(`[${bot.name}] .. ${chatId}: dropped, ${state.cancelled}`);
        return;
      }

      // Cleared before waiting, so that a message arriving during the debounce
      // is not logged as having interrupted a generation that already finished.
      state.controller = null;
      if (!(await settleInput(chatId, state))) return;

      state.controller = new AbortController();

      let reply;
      try {
        reply = await bot.handle(chatId, state.parts.join('\n'), {
          isSim: false,
          from: chatId,
          // Read when the bot asks, not when this was queued, so a lookup that
          // landed while the reply was being written is still used.
          get name() {
            return names.get(chatId) || '';
          },
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

  /**
   * What to call the person a chat is with.
   *
   * The transcript a briefing is written from is only "User:" and "Assistant:",
   * so without this the model is asked what somebody wants while being told
   * nothing about who they are, and an ID is no use on a notification either.
   * Saved name first, since that is the one you would recognise.
   *
   * Looked up once and kept. The empty string is stored straight away so that a
   * burst of messages starts one lookup rather than one each, and the answer is
   * handed to the bot when it lands rather than awaited here, which would put a
   * browser round trip in front of every reply.
   */
  /**
   * Loads the model before anybody has asked it for anything.
   *
   * Called when the fixed reply goes out, which is the moment two things become
   * true: somebody is at the other end right now, and they have just been told
   * to use the prefix if they want a real answer. In auto mode the model is
   * otherwise idle all day and Ollama has long since evicted it, so without
   * this the first prefixed message pays to read the weights off disk with
   * somebody watching. Here it is paid while they read the fixed reply.
   *
   * Never awaited, and its failures are a warning rather than an error. If the
   * warm-up does not happen the next question is merely as slow as it used to
   * be, which is not worth failing a reply over.
   */
  let lastWarm = 0;
  function warmModel() {
    // Only ever reached from the fixed-reply route, which classify has already
    // decided is on, allowed and not a group, so there is nothing to re-check.
    if (!bot.warm) return;

    const at = Date.now();
    if (at - lastWarm < WARM_THROTTLE_MS) return;
    lastWarm = at;

    Promise.resolve()
      .then(() => bot.warm())
      .catch((err) => console.warn('[ollama] warm-up failed:', err.message));
  }

  const names = new Map();
  function nameFor(msg, chatId) {
    if (names.has(chatId)) return names.get(chatId);

    names.set(chatId, '');
    if (names.size > 500) names.delete(names.keys().next().value);

    Promise.resolve(typeof msg.getContact === 'function' ? msg.getContact() : null)
      .then((contact) => {
        if (!contact) return;
        const found = String(contact.name || contact.pushname || contact.shortName || '').trim();
        if (!found || found === chatId) return;
        names.set(chatId, found);
        if (bot.rename) bot.rename(chatId, found);
      })
      .catch(() => {});

    return '';
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

    // Started here for its side effect, not for what it returns. Every route
    // out of this handler eventually wants the name, but the one that reaches
    // the model builds its own context inside answer(), so leaving the lookup
    // to whoever read it first meant it was never started at all.
    nameFor(msg, chatId);

    const live = runtime.writing.get(chatId);
    // autoText so that "away 2h in a meeting" overrides the configured wording
    // without the bot having to read runtime state it does not own.
    const ctx = {
      isSim: false,
      from: chatId,
      // A getter, so it is read when the bot uses it rather than now. The
      // lookup is a round trip into the browser and has usually not come back
      // yet at this point, and reading it here froze the empty string in.
      get name() {
        return names.get(chatId) || '';
      },
      autoText: autoReply(runtime),
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
      // Whether or not the fixed reply is due. Somebody writing in is the
      // signal, and a conversation already inside the gap is one where the
      // prefix is even likelier to turn up next.
      warmModel();

      // Recorded either way, so the briefing covers everything they sent rather
      // than only the message that happened to earn a reply. Without this, a
      // conversation the fixed reply handled would reach you as silence.
      if (!due) {
        // Through the queue, so it lands behind any reply still being written
        // for this chat. Recording it here and now put the later message above
        // the earlier one in the transcript, which both the model and the
        // briefing then read in the wrong order.
        if (bot.observe) queue.push(async () => bot.observe(chatId, decision.text, ctx));
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

    // Noted after classify has read it, so this message does not decide its own
    // routing. From here the next few minutes need no prefix.
    runtime.noteEngaged(chatId);

    const amending = Boolean(live) && live.restarts < access.maxInterrupts;

    // An amendment produces no reply of its own, so it has nothing to charge
    // against the hourly cap: two messages, one answer, one slot.
    if (!amending && !affordable(chatId)) return;

    if (amending) {
      live.parts.push(decision.text);
      // What the debounce measures from, so each new part restarts the wait.
      live.lastPart = Date.now();

      // Counted whether or not there is anything to interrupt. Only counting
      // aborts meant a reply waiting behind another conversation had no
      // controller yet, so MAX_INTERRUPTS never advanced and one sender could
      // fold an unlimited number of messages into a single prompt.
      //
      // A message landing inside the debounce is the one exception: no
      // generation has started, so nothing was thrown away and there is nothing
      // to charge for. Charging it anyway would spend the entire interrupt
      // budget on exactly the burst the debounce exists to absorb, and the
      // fourth message of a burst would start a second reply of its own.
      if (!live.debouncing) live.restarts += 1;

      if (live.controller) {
        live.controller.abort();
        console.log(`[${bot.name}] .. ${chatId}: amended, writing it again`);
      }
      return;
    }

    const state = {
      parts: [decision.text],
      restarts: 0,
      controller: null,
      cancelled: null,
      lastPart: Date.now(),
      debouncing: false,
    };
    runtime.noteWriting(chatId, state);

    queue.push(async () => {
      try {
        await answer(chatId, state);
      } finally {
        runtime.doneWriting(state);
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
        for (const chat of runtime.activeChats()) runtime.cancel(chat, reason);
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
    // named(), not allows(). An empty ALLOWED_CONTACTS means anyone may write
    // in, but it cannot also mean anyone may be written to: that turned
    // SEND_API_ALLOW_ANY=false into a no-op in the configuration most people
    // start from, so a leaked key could message any number in the world.
    allows: (to) => sendCfg.allowAny || identity.named(to),
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

  // Safe, but useless, and it would otherwise present as "n8n is broken".
  if (server && !sendCfg.allowAny && identity.open) {
    console.warn(
      '[send] ALLOWED_CONTACTS is empty and SEND_API_ALLOW_ANY is false, so ' +
        'every recipient will be refused. Put the numbers you want to reply to ' +
        'in ALLOWED_CONTACTS.'
    );
  }

  installShutdown(bot, server ? [() => stopSendApi(server)] : []);
  client.initialize();
  return { client, runtime, identity, queue, server };
}

async function runSim(bot) {
  console.log(`--- ${bot.name}: terminal simulation, reply mode: ${access.replyMode} ---`);
  if (!(await preflight(bot))) process.exit(1);
  installShutdown(bot);
  console.log(
    `Type a message and press enter. ${access.commandPrefix} status, ` +
      `${access.commandPrefix} away 2h and the rest work here too. Ctrl+C to exit.\n`
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const queue = new SerialQueue(bot.name);
  const runtime = new RuntimeState({
    mode: access.replyMode,
    autoGapMs: access.autoReplyGapMinutes * 60 * 1000,
    autoMaxPerDay: access.autoReplyMaxPerDay,
    followUpMs: access.followUpMinutes * 60 * 1000,
  });

  // autoText is read per message rather than fixed here, so that away state set
  // during the session takes effect the same way it does over WhatsApp.
  const context = () => ({
    isSim: true,
    from: null,
    autoText: autoReply(runtime),
  });

  const ask = () => {
    rl.question('you: ', (input) => {
      const text = input.trim();
      if (!text) return ask();

      // Before classify, because over WhatsApp a command is told apart by
      // arriving from you, and the simulation has nobody to be. Without this
      // every "/ai off" typed in here was quietly handed to the model as a
      // question, so the one place to rehearse the away wording could not
      // reach the away state at all.
      const command = stripPrefix(text, access.commandPrefix);
      if (access.ownerCommands !== 'off' && command !== null && isCommand(command)) {
        const reply = runCommand(runtime, command, {
          cancelAll: (reason) => {
            for (const chat of runtime.activeChats()) runtime.cancel(chat, reason);
          },
        });
        console.log(`${reply}\n`);
        return ask();
      }

      const decision = classify(
        { from: 'sim', body: text, timestamp: Math.floor(Date.now() / 1000) },
        runtime,
        { simulated: true }
      );

      // After classify, not before. effectiveMode() is what notices that an
      // away has lapsed and clears its wording, so reading the wording first
      // sent one last stale reason after it had expired.
      const ctx = context();

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
        console.log(`${bot.auto ? bot.auto('sim', decision.text, ctx) : ctx.autoText}\n`);
        return ask();
      }

      runtime.noteInbound('sim');
      runtime.noteEngaged('sim');
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
