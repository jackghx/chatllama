const HOUR_MS = 60 * 60 * 1000;

/**
 * Per-conversation reply cap over a rolling hour.
 *
 * In prefix mode a runaway loop was not really possible: something had to type
 * the command prefix. Replying to everything removes that, and two auto
 * repliers pointed at each other, or this one and any other, will answer each
 * other until someone notices. The cap is per conversation so one loop cannot
 * silence the rest.
 *
 * Counts live in memory only, so a restart clears them.
 */
class RateLimiter {
  constructor(maxPerHour) {
    this.maxPerHour = maxPerHour;
    this.hits = new Map();
    this.breached = new Set();
  }

  /** Records a reply and returns true, or returns false if the cap is hit. */
  allow(id, now = Date.now()) {
    if (this.maxPerHour <= 0) return true;

    const recent = (this.hits.get(id) || []).filter((t) => t > now - HOUR_MS);
    this.hits.set(id, recent);

    if (recent.length >= this.maxPerHour) return false;

    recent.push(now);
    this.breached.delete(id);
    return true;
  }

  /** True the first time a conversation breaches, so the log stays readable. */
  firstBreach(id) {
    if (this.breached.has(id)) return false;
    this.breached.add(id);
    return true;
  }
}

module.exports = { RateLimiter };
