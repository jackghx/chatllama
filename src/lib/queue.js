// Five messages in five seconds would otherwise be five concurrent Ollama
// requests, all reading conversation memory before any of them writes back.
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
