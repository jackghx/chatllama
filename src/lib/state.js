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
  constructor({ mode, autoGapMs = 0, autoMaxPerDay = 0 }) {
    // Starts from REPLY_MODE and is what the message handler actually reads.
    // Config is the setting, this is the state.
    this.mode = mode;

    this.autoGapMs = autoGapMs;
    this.autoMaxPerDay = autoMaxPerDay;

    // When each conversation last wrote in, and how many fixed replies they
    // have had today. Both only matter in auto mode.
    this.lastInbound = new Map();
    this.autoReplies = new Map();

    // Conversations with a reply currently being written. Someone who corrects
    // themselves mid-sentence should get one answer to the whole thing, not an
    // answer to the half they have already taken back.
    this.writing = new Map();

    // Senders already printed in capture mode, so the log is a list to paste
    // rather than a running commentary.
    this.captured = new Set();

    // Set on ready, and the only chat owner commands are read from by default.
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
    const live = this.writing.get(chatId);
    if (!live) return false;

    live.cancelled = reason;
    if (live.controller) live.controller.abort();
    this.writing.delete(chatId);
    return true;
  }
}

module.exports = { RuntimeState };
