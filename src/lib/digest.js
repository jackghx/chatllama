/**
 * Collapses a burst of messages into one notification.
 *
 * WhatsApp has no end-of-conversation event, so the end is inferred from
 * silence: every reply resets that conversation's timer, and when it runs out
 * onFlush is called once with what accumulated. maxMessages is the ceiling for
 * a conversation that never goes quiet.
 */
class Digest {
  constructor({ idleMs, maxMessages = 0, onFlush }) {
    this.idleMs = idleMs;
    this.maxMessages = maxMessages;
    this.onFlush = onFlush;
    this.pending = new Map();
  }

  get enabled() {
    return this.idleMs > 0;
  }

  track(id, meta = {}) {
    if (!this.enabled) return;

    const state = this.pending.get(id) || { messages: 0, since: Date.now(), meta: {} };
    state.messages += 1;
    state.meta = { ...state.meta, ...meta };
    clearTimeout(state.timer);
    this.pending.set(id, state);

    if (this.maxMessages > 0 && state.messages >= this.maxMessages) {
      this.flush(id, 'cap');
      return;
    }

    // unref so a waiting summary is never the only thing keeping the process
    // alive. Anything still pending at that point is the shutdown flush's job.
    state.timer = setTimeout(() => this.flush(id, 'idle'), this.idleMs).unref();
  }

  /**
   * Attaches a name learned after the conversation was first tracked.
   *
   * Looking a contact up costs a round trip into the browser, so it is started
   * when they first write and lands a moment later. The briefing is written
   * minutes after that, so waiting for the name at track() time would hold up a
   * message for something only the notification needs.
   */
  rename(id, name) {
    const state = this.pending.get(id);
    if (state && name) state.meta = { ...state.meta, name };
  }

  // Deleting first means a flush already under way cannot be started twice by
  // the timer and the shutdown handler racing each other.
  flush(id, reason) {
    const state = this.pending.get(id);
    if (!state) return Promise.resolve();

    clearTimeout(state.timer);
    this.pending.delete(id);

    const summary = {
      messages: state.messages,
      since: state.since,
      meta: state.meta,
      reason,
    };

    return Promise.resolve()
      .then(() => this.onFlush(id, summary))
      .catch((err) => console.error('[digest] flush failed:', err.message));
  }

  flushAll(reason = 'shutdown') {
    return Promise.all([...this.pending.keys()].map((id) => this.flush(id, reason)));
  }
}

module.exports = { Digest };
