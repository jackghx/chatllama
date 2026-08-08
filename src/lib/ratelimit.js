const HOUR_MS = 60 * 60 * 1000;
const SWEEP_ABOVE = 1000;

/**
 * Per-conversation reply cap over a rolling hour. Two auto repliers pointed at
 * each other stop after 20 messages rather than overnight. Counts are in
 * memory, so a restart clears them.
 */
class RateLimiter {
  constructor(maxPerHour) {
    this.maxPerHour = maxPerHour;
    this.hits = new Map();
    this.breached = new Set();
  }

  allow(id, now = Date.now()) {
    if (this.maxPerHour <= 0) return true;

    const recent = (this.hits.get(id) || []).filter((t) => t > now - HOUR_MS);

    if (recent.length >= this.maxPerHour) {
      this.hits.set(id, recent);
      return false;
    }

    recent.push(now);
    this.hits.set(id, recent);
    this.breached.delete(id);

    if (this.hits.size > SWEEP_ABOVE) this.sweep(now);
    return true;
  }

  // Once per breach, or the log fills with one conversation.
  firstBreach(id) {
    if (this.breached.has(id)) return false;
    this.breached.add(id);
    return true;
  }

  sweep(now = Date.now()) {
    for (const [id, times] of this.hits) {
      if (!times.some((t) => t > now - HOUR_MS)) {
        this.hits.delete(id);
        this.breached.delete(id);
      }
    }
  }
}

module.exports = { RateLimiter };
