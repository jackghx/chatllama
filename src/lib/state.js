/**
 * Everything about a running bot that changes after it has started.
 *
 * It is one object rather than a handful of module-scope maps so that two runs
 * in the same process cannot share it, and so a test can read what the bot
 * believes rather than inferring it from what it did or did not send.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

// Above this many conversations remembered, the stale ones are dropped. Nothing
// here needs to be exact, it only has to stop a long-running process growing a
// map entry for every stranger who ever wrote in.
const SWEEP_ABOVE = 1000;

// Message IDs the bot sent itself, kept only long enough to recognise them
// coming back on message_create. A handful would do; this is slack.
const SELF_SENT_MAX = 200;

class RuntimeState {
  constructor({ mode, autoGapMs = 0, autoMaxPerDay = 0, followUpMs = 0 }) {
    // Starts from REPLY_MODE and is what the message handler actually reads.
    // Config is the setting, this is the state.
    this.mode = mode;

    this.autoGapMs = autoGapMs;
    this.autoMaxPerDay = autoMaxPerDay;
    this.followUpMs = followUpMs;

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
