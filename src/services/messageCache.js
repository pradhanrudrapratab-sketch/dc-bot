'use strict';

/**
 * Bounded in-memory snapshot cache so message edit/delete logs can show original content.
 * Deliberately NOT persisted (privacy): after a restart or an eviction, content is simply unavailable.
 */
function createMessageCache({ max = 5000, ttlMs = 24 * 3_600_000, now = () => Date.now() } = {}) {
  const map = new Map();
  const snap = (m) => ({
    id: m.id, guildId: m.guildId, channelId: m.channelId, authorId: m.author?.id ?? null, authorTag: m.author?.tag ?? null,
    content: m.content ?? '', createdAt: m.createdTimestamp ?? now(),
    attachments: [...(m.attachments?.values?.() ?? [])].map((a) => ({ name: a.name, url: a.url, size: a.size, contentType: a.contentType ?? null })),
    cachedAt: now(),
  });
  function put(message) {
    map.delete(message.id);
    map.set(message.id, snap(message));
    while (map.size > max) map.delete(map.keys().next().value); // evict oldest
  }
  function get(id) {
    const e = map.get(id);
    if (!e) return null;
    if (now() - e.cachedAt > ttlMs) { map.delete(id); return null; }
    return e;
  }
  const update = (message) => { const prev = get(message.id); put(message); return prev; };
  const take = (id) => { const e = get(id); map.delete(id); return e; };
  return { put, get, update, take, size: () => map.size };
}

module.exports = { createMessageCache };
