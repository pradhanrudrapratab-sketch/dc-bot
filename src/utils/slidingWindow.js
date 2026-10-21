'use strict';

/** Counts events per key inside a rolling window. */
class SlidingWindowCounter {
  constructor({ windowMs = 60_000, now = () => Date.now() } = {}) {
    this.windowMs = windowMs;
    this.now = now;
    this.events = new Map();
  }

  /** Record an event and return how many fall inside the window (including this one). */
  record(key, meta) {
    const t = this.now();
    const list = (this.events.get(key) || []).filter((e) => t - e.at < this.windowMs);
    list.push({ at: t, meta });
    this.events.set(key, list);
    return list.length;
  }

  peek(key) {
    const t = this.now();
    return (this.events.get(key) || []).filter((e) => t - e.at < this.windowMs);
  }

  clear(key) {
    this.events.delete(key);
  }
}

module.exports = { SlidingWindowCounter };
