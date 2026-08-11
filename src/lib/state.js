/**
 * Everything about a running bot that changes after it has started.
 *
 * It is one object rather than a handful of module-scope maps so that two runs
 * in the same process cannot share it, and so a test can read what the bot
 * believes rather than inferring it from what it did or did not send.
 */
const fs = require('fs');
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;

// Away with no end set. JSON has no Infinity, so it travels as this word and is
// turned back into a number on the way in.
const FOREVER = 'forever';

// Above this many conversations remembered, the stale ones are dropped. Nothing
// here needs to be exact, it only has to stop a long-running process growing a
// map entry for every stranger who ever wrote in.
const SWEEP_ABOVE = 1000;

// Message IDs the bot sent itself, kept only long enough to recognise them
// coming back on message_create. A handful would do; this is slack.
const SELF_SENT_MAX = 200;

class RuntimeState {
  constructor({
    mode,
    autoGapMs = 0,
    autoMaxPerDay = 0,
    followUpMs = 0,
    handoverMs = 0,
    stateFile = '',
    // Passed in rather than imported, so that state.js keeps knowing nothing
    // about where settings live and a test can drive the clock directly.
    isQuiet = null,
    quietMode = 'auto',
  }) {
    this.isQuiet = isQuiet;
    this.quietMode = quietMode;
    // Starts from REPLY_MODE and is what the message handler actually reads.
    // Config is the setting, this is the state.
    this.mode = mode;

    // Where away and mode are kept, so that a restart does not quietly undo
    // them. Empty means nothing is written, which is what the simulation uses:
    // a rehearsal must not be able to change what the real bot does.
    this.stateFile = stateFile;
    this.configuredMode = mode;

    this.autoGapMs = autoGapMs;
    this.autoMaxPerDay = autoMaxPerDay;
    this.followUpMs = followUpMs;
    this.handoverMs = handoverMs;

    // When the owner last answered each conversation themselves. While that is
    // recent the bot stays out of that one chat entirely.
    this.handedOver = new Map();

    // When each conversation last reached the model. While that is recent the
    // prefix is not needed again, because nobody remembers to type it twice and
    // the alternative is the fixed reply landing on a real question.
    this.engaged = new Map();

    // When each conversation last wrote in, and how many fixed replies they
    // have had today. Both only matter in auto mode.
    this.lastInbound = new Map();
    this.autoReplies = new Map();

    // Conversations with a reply currently being written. Someone who corrects
    // themselves mid-sentence should get one answer to the whole thing, not an
    // answer to the half they have already taken back.
    // The newest reply being written per conversation, which is what a further
    // message amends. Not every reply in flight: see inFlight below.
    this.writing = new Map();
    // All of them, including any left running after MAX_INTERRUPTS was reached
    // and a second reply started. Cancelling has to reach these too.
    this.inFlight = new Set();

    // Senders already printed in capture mode, so the log is a list to paste
    // rather than a running commentary.
    this.captured = new Set();

    // Every identifier your own chat might be keyed by, filled in on ready.
    // There is more than one because WhatsApp reports the account as a phone
    // number while keying the chat itself by its linked ID, and a message the
    // owner sent carries no field that ties the two together.
    this.selfChats = new Set();

    // The one to print. The set above is what gets matched against.
    this.selfChat = null;

    // Every message the bot sent. WhatsApp reports those back on the same event
    // that carries the owner's own typing, so without this a reply that happened
    // to begin with the command prefix would be read as an instruction.
    this.selfSent = new Set();

    // Infinity means away with no end set. The text overrides the configured
    // fixed reply while it lasts.
    this.awayUntil = 0;
    this.awayText = '';

    // Whether WhatsApp is actually connected: starting, ready, disconnected or
    // auth_failure. The process staying up is not the same as the bot working,
    // and a session that dropped in the night is the one failure nobody notices
    // from the outside, because a bot that answers nothing looks exactly like a
    // quiet day.
    this.connection = 'starting';
    this.connectionSince = Date.now();
    this.connectionNote = '';
    this.startedAt = Date.now();
    // When a message was last seen, in either direction. A session can be
    // connected and still be wedged, and this is what shows it.
    this.lastMessageAt = 0;

    // What was in force when the process last stopped. Read here rather than by
    // the caller so there is no window where the bot is running under the
    // configured mode before the saved one lands.
    this.restored = this.restore();
  }

  /**
   * Reads back the away state and mode from the last run.
   *
   * "/ai away 1w" is a promise the bot makes to whoever writes in, and pm2
   * restarting at four in the morning is not the owner cancelling it. What is
   * stored is the absolute moment the away ends rather than what is left of it,
   * so time spent down still counts: away for a week, restarted on day three,
   * still away until day seven.
   *
   * Returns a line to log, or null when there was nothing to restore. Every
   * failure is swallowed. A file that cannot be read means starting from the
   * configured mode, which is the old behaviour and is never worse than
   * refusing to start.
   */
  restore(at = Date.now()) {
    if (!this.stateFile) return null;

    let saved;
    try {
      const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      saved = data && data.state;
    } catch {
      // Missing on the first run, and a damaged one rebuilds itself on the next
      // command rather than being worth a word to anybody.
      return null;
    }
    if (!saved || typeof saved !== 'object') return null;

    const notes = [];

    // Only the modes that exist. Anything else is a file written by a different
    // version, or by hand, and the configured mode is the safer answer.
    if (['always', 'prefix', 'auto', 'off'].includes(saved.mode)) {
      if (saved.mode !== this.mode) {
        notes.push(`mode ${saved.mode}, set by command rather than by REPLY_MODE`);
      }
      this.mode = saved.mode;
    }

    const until = saved.awayUntil === FOREVER ? Infinity : Number(saved.awayUntil);

    if (until === Infinity) {
      this.awayUntil = Infinity;
      this.awayText = String(saved.awayText || '');
      notes.push('still away, with no end set');
    } else if (Number.isFinite(until) && until > at) {
      this.awayUntil = until;
      this.awayText = String(saved.awayText || '');
      const left = Math.max(1, Math.round((until - at) / 60000));
      notes.push(`still away for another ${left} min`);
    }
    // An away that ran out while the process was down is simply over, and
    // nothing is restored from it.

    return notes.length ? notes.join(', ') : null;
  }

  /**
   * Writes the away state and mode out, so the next start reads them back.
   *
   * Called from the commands that change them rather than on a timer, because
   * those are the only things that change them and there are a handful a day.
   */
  save() {
    if (!this.stateFile) return;

    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(
        this.stateFile,
        JSON.stringify(
          {
            version: 1,
            state: {
              mode: this.mode,
              awayUntil: this.awayUntil === Infinity ? FOREVER : this.awayUntil,
              awayText: this.awayText,
            },
            // Not read back. It is here so that somebody looking at the file can
            // tell a stale one from a live one.
            savedAt: new Date().toISOString(),
          },
          null,
          2
        )
      );
    } catch (err) {
      console.warn('[state] could not be saved:', err.message);
    }
  }

  /**
   * The mode actually in force, which is the configured one unless away is
   * running. Clears an expired away as a side effect, because this is the only
   * thing that runs often enough to notice.
   */
  effectiveMode(at = Date.now()) {
    if (this.awayUntil) {
      if (at < this.awayUntil) return 'auto';
      this.awayUntil = 0;
      this.awayText = '';
    }

    // Quiet hours are the standing version of away: the same behaviour, on a
    // clock, so that it does not have to be remembered every evening. It never
    // overrides "off", because a bot switched off stays off whatever the time,
    // and it cannot make a quiet night noisier than the configured mode.
    if (this.mode !== 'off' && this.isQuiet && this.isQuiet(new Date(at))) {
      return this.quietMode;
    }

    return this.mode;
  }

  /**
   * Records one of the owner's own identifiers, the first becoming the one
   * shown at startup. Only ever called with the account's own IDs, so this
   * cannot widen who may steer the bot beyond the owner.
   */
  addSelfChat(id) {
    if (!id) return;
    if (!this.selfChat) this.selfChat = id;
    this.selfChats.add(id);
  }

  isSelfChat(id) {
    return Boolean(id) && this.selfChats.has(id);
  }

  /**
   * Records what the WhatsApp connection is doing.
   *
   * Returns true when this is a change rather than a repeat, so the caller can
   * notify once instead of on every retry.
   */
  noteConnection(status, note = '', at = Date.now()) {
    if (this.connection === status) return false;
    this.connection = status;
    this.connectionSince = at;
    this.connectionNote = note;
    return true;
  }

  noteSelfSent(id) {
    this.selfSent.add(id);
    if (this.selfSent.size <= SELF_SENT_MAX) return;

    // Sets iterate in insertion order, so this drops the oldest.
    let excess = this.selfSent.size - SELF_SENT_MAX;
    for (const key of this.selfSent) {
      if (excess-- <= 0) break;
      this.selfSent.delete(key);
    }
  }

  /**
   * Whether the fixed reply is due for this conversation.
   *
   * The gap is measured from when they last wrote, not from when we last
   * replied. That way a burst of messages gets one reply and somebody coming
   * back tomorrow gets another, which is how an away message reads to a person.
   * A cooldown would instead fire again as soon as the clock ran out, landing
   * in the middle of a conversation already under way.
   *
   * Call it before noteInbound, or the gap is always zero.
   */
  shouldAutoReply(chatId, at = Date.now()) {
    const last = this.lastInbound.get(chatId);
    if (last !== undefined && at - last < this.autoGapMs) return false;

    if (this.autoMaxPerDay <= 0) return true;
    const record = this.autoReplies.get(chatId);
    if (!record || record.day !== Math.floor(at / DAY_MS)) return true;
    return record.count < this.autoMaxPerDay;
  }

  /**
   * Whether this conversation is still talking to the model.
   *
   * Measured from their last answered message rather than from the one that
   * carried the prefix, so a conversation that keeps going keeps going, and one
   * that stops falls back to the fixed reply on its own.
   */
  isEngaged(chatId, at = Date.now()) {
    if (this.followUpMs <= 0) return false;
    const last = this.engaged.get(chatId);
    return last !== undefined && at - last < this.followUpMs;
  }

  noteEngaged(chatId, at = Date.now()) {
    this.engaged.set(chatId, at);
    if (this.engaged.size > SWEEP_ABOVE) {
      for (const [id, when] of this.engaged) {
        if (at - when > this.followUpMs) this.engaged.delete(id);
      }
    }
  }

  /**
   * Whether the owner has recently answered this conversation themselves, and
   * the bot should therefore keep out of it.
   *
   * This is the other half of recording what the owner sends, and the more
   * important half. Somebody who replies by hand is plainly at their phone, so
   * the fixed reply saying nobody is watching this number is now a lie, and it
   * would be sent seconds after they had proof otherwise. Worse in the case
   * that prompted it: a reply approved from a briefing goes out unmarked, as
   * the owner, so the person answers a human and the bot picks the thread back
   * up underneath them.
   *
   * Per conversation, because being at your phone for one person says nothing
   * about the other twelve.
   */
  isHandedOver(chatId, at = Date.now()) {
    if (this.handoverMs <= 0) return false;
    const last = this.handedOver.get(chatId);
    return last !== undefined && at - last < this.handoverMs;
  }

  noteHandedOver(chatId, at = Date.now()) {
    this.handedOver.set(chatId, at);
    if (this.handedOver.size > SWEEP_ABOVE) {
      for (const [id, when] of this.handedOver) {
        if (at - when > this.handoverMs) this.handedOver.delete(id);
      }
    }
  }

  /**
   * Hands every conversation back to the bot.
   *
   * "/ai away" is the owner saying they have gone, which outranks anything
   * inferred from them having replied to somebody an hour ago.
   */
  clearHandovers() {
    this.handedOver.clear();
  }

  noteInbound(chatId, at = Date.now()) {
    this.lastInbound.set(chatId, at);
    if (this.lastInbound.size > SWEEP_ABOVE) {
      for (const [id, when] of this.lastInbound) {
        if (at - when > DAY_MS) this.lastInbound.delete(id);
      }
    }
  }

  noteAutoReply(chatId, at = Date.now()) {
    const day = Math.floor(at / DAY_MS);
    const record = this.autoReplies.get(chatId);

    if (record && record.day === day) record.count += 1;
    else this.autoReplies.set(chatId, { day, count: 1 });

    if (this.autoReplies.size > SWEEP_ABOVE) {
      for (const [id, seen] of this.autoReplies) {
        if (seen.day !== day) this.autoReplies.delete(id);
      }
    }
  }

  /**
   * Abandons the reply being written for a conversation, if there is one.
   *
   * Different from the abort an amendment does. That one throws the attempt away
   * so it can be written again with more to go on, and the loop in answer()
   * starts over. This one means no reply should be sent at all, so the reason is
   * recorded on the entry and answer() stops when it sees it.
   */
  cancel(chatId, reason) {
    let stopped = false;

    // Every reply in flight for this chat, not only the newest. Once a
    // conversation has used up MAX_INTERRUPTS the next message starts a second
    // reply, which overwrote the map entry and left the first one running with
    // nothing pointing at it. "off" then cancelled the one it could see and the
    // orphan carried on and sent, which is the one thing off has to prevent.
    for (const state of this.inFlight) {
      if (state.chatId !== chatId) continue;
      state.cancelled = reason;
      if (state.controller) state.controller.abort();
      this.inFlight.delete(state);
      stopped = true;
    }

    this.writing.delete(chatId);
    return stopped;
  }

  /** Every conversation with a reply in flight, for cancelling the lot. */
  activeChats() {
    return [...new Set([...this.inFlight].map((s) => s.chatId))];
  }

  noteWriting(chatId, state) {
    state.chatId = chatId;
    this.inFlight.add(state);
    // The amendment target is the newest, so a later message folds into the
    // reply being written now rather than into one already on its way out.
    this.writing.set(chatId, state);
  }

  doneWriting(state) {
    this.inFlight.delete(state);
    if (this.writing.get(state.chatId) === state) this.writing.delete(state.chatId);
  }
}

module.exports = { RuntimeState };
