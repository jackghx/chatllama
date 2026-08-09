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

  /**
   * Returns a promise that settles when the task has finished, so a caller that
   * has to wait for the work can, without giving up the serialisation. It never
   * rejects: a failing task is logged in drain() and the queue carries on.
   */
  push(task) {
    const done = new Promise((resolve) => {
      this.tasks.push(async () => {
        try {
          await task();
        } finally {
          resolve();
        }
      });
    });
    this.drain();
    return done;
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
