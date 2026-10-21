'use strict';

/** Serialises async work per key (e.g. per guild) without a global lock. */
class KeyedMutex {
  constructor() {
    this.tails = new Map();
  }

  async run(key, fn) {
    const prev = this.tails.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((r) => { release = r; });
    const tail = prev.then(() => gate);
    this.tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

module.exports = { KeyedMutex };
