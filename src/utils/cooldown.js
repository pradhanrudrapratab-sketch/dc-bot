'use strict';

/** In-memory per-(scope,user) cooldowns. `now` is injectable for tests. */
class CooldownManager {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.map = new Map();
  }

  /** @returns {number} remaining ms (0 = allowed). Consumes the cooldown when allowed. */
  consume(scope, userId, durationMs) {
    if (!durationMs || durationMs <= 0) return 0;
    const key = `${scope}:${userId}`;
    const t = this.now();
    const until = this.map.get(key) || 0;
    if (until > t) return until - t;
    this.map.set(key, t + durationMs);
    if (this.map.size > 5000) this.sweep();
    return 0;
  }

  sweep() {
    const t = this.now();
    for (const [k, until] of this.map) if (until <= t) this.map.delete(k);
  }
}

module.exports = { CooldownManager };
