/**
 * Runs async tasks strictly one at a time.
 *
 * Without this, five messages arriving in quick succession fire five
 * concurrent Ollama requests. They all read the conversation memory
 * before any of them writes back to it, so context is corrupted, and
 * CPU inference on an 8B model does not cope well with the parallelism.
 */
class SerialQueue {
  constructor(label = 'queue') {
    this.label = label;
    this.tasks = [];
    this.running = false;
  }

  get length() {
    return this.tasks.length;
  }

  push(task) {
    this.tasks.push(task);
    this.drain();
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    while (this.tasks.length) {
      const task = this.tasks.shift();
      try {
        await task();
      } catch (err) {
        console.error(`[${this.label}] task failed:`, err.message);
      }
    }
    this.running = false;
  }
}

module.exports = { SerialQueue };
