// Window counts lines, not exchanges, so 20 holds roughly 10 turns. The
// conversation cap matters because this runs for months and in always mode
// every stranger who messages the number would otherwise be kept forever.
class ConversationStore {
  constructor(maxLines = 20, maxConversations = 500) {
    this.maxLines = maxLines;
    this.maxConversations = maxConversations;
    this.conversations = new Map();
  }

  lines(id) {
    return this.conversations.get(id) || [];
  }

  push(id, line) {
    const lines = this.conversations.get(id) || [];
    lines.push(line);
    while (lines.length > this.maxLines) lines.shift();

    // Re-inserting moves the key to the end, so Map order is least recent first.
    this.conversations.delete(id);
    this.conversations.set(id, lines);

    while (this.conversations.size > this.maxConversations) {
      this.conversations.delete(this.conversations.keys().next().value);
    }
  }

  clear(id) {
    this.conversations.delete(id);
  }
}

module.exports = { ConversationStore };
