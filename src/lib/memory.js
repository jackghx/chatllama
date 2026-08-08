/**
 * Sliding window conversation memory, keyed by conversation ID.
 *
 * The single-file prototype this repo grew out of used one global array,
 * which meant two people messaging the same bot shared one context and
 * saw fragments of each other's conversation. Memory is per-conversation
 * here so that cannot happen.
 *
 * The window counts lines, not exchanges. A window of 20 holds roughly
 * 10 turns, since each turn contributes a user line and a bot line.
 */
class ConversationStore {
  constructor(maxLines = 20) {
    this.maxLines = maxLines;
    this.conversations = new Map();
  }

  lines(id) {
    return this.conversations.get(id) || [];
  }

  push(id, line) {
    const lines = this.conversations.get(id) || [];
    lines.push(line);
    while (lines.length > this.maxLines) lines.shift();
    this.conversations.set(id, lines);
  }

  clear(id) {
    this.conversations.delete(id);
  }
}

module.exports = { ConversationStore };
