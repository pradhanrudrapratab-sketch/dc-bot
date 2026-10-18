'use strict';
const { embed } = require('../utils/embeds');
const logger = require('../utils/logger');
const { LOG_CATEGORIES } = require('./audit');

const NEEDED = ['ViewChannel', 'SendMessages', 'EmbedLinks'];

/**
 * Delivers audit entries/alerts to per-guild log channels and alerts staff.
 * Missing channel permissions mark only that log feature as degraded (via the permission monitor).
 */
function createLogDispatcher({ db, getClient, permissionMonitor = null, now = () => Date.now() }) {
  const memo = new Map(); // feature -> last reported missing key (avoid a DB hit per event)

  async function track(guildId, feature, missing) {
    if (!permissionMonitor) return;
    const key = `${guildId}:${feature}`;
    const sig = [...missing].sort().join(',');
    if (memo.get(key) === sig) return;
    memo.set(key, sig);
    await permissionMonitor.report(guildId, feature, missing).catch(() => {});
  }

  async function getSettings(guildId, category) {
    return (await db.query('SELECT * FROM log_settings WHERE guild_id = $1 AND category = $2', [guildId, category])).rows[0] || null;
  }
  async function listSettings(guildId) {
    return (await db.query('SELECT * FROM log_settings WHERE guild_id = $1', [guildId])).rows;
  }
  async function setSettings(guildId, category, { channelId, enabled }) {
    if (!LOG_CATEGORIES.includes(category)) throw new Error(`Unknown log category: ${category}`);
    const cur = await getSettings(guildId, category);
    await db.query(
      `INSERT INTO log_settings (guild_id, category, channel_id, enabled, updated_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (guild_id, category) DO UPDATE SET channel_id = excluded.channel_id, enabled = excluded.enabled, updated_at = excluded.updated_at`,
      [guildId, category, channelId !== undefined ? channelId : cur?.channel_id ?? null, enabled !== undefined ? (enabled ? 1 : 0) : cur?.enabled ?? 0, now()]
    );
  }
  /** Fast check used by event handlers before doing any work. */
  async function isEnabled(guildId, category) {
    const s = await getSettings(guildId, category);
    return !!(s && s.enabled && s.channel_id);
  }

  async function sendToChannel(guild, channelId, payload, feature) {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || typeof channel.send !== 'function') {
      await track(guild.id, feature, ['ViewChannel']);
      return { sent: false, reason: 'CHANNEL_MISSING' };
    }
    const me = guild.members.me;
    const perms = channel.permissionsFor?.(me);
    const missing = NEEDED.filter((p) => !perms?.has(p));
    await track(guild.id, feature, missing);
    if (missing.length) return { sent: false, reason: 'MISSING_PERMISSIONS', missing };
    try {
      await channel.send({ ...payload, allowedMentions: { parse: [] } });
      return { sent: true };
    } catch (err) {
      logger.warn('[LOG] send failed', { error: err, guildId: guild.id, channelId });
      return { sent: false, reason: 'SEND_FAILED' };
    }
  }

  /** Send a payload to the category's channel if enabled. */
  async function send(guildId, category, payload) {
    const s = await getSettings(guildId, category);
    if (!s || !s.enabled || !s.channel_id) return { sent: false, reason: 'DISABLED' };
    const guild = getClient().guilds.cache.get(guildId);
    if (!guild) return { sent: false, reason: 'NO_GUILD' };
    return sendToChannel(guild, s.channel_id, payload, `log:${category}`);
  }

  /** Audit fan-out sink: turns an audit entry into an embed. */
  async function sink(guildId, category, entry) {
    const failed = entry.result !== 'SUCCESS';
    const make = failed ? embed.error : embed.brand;
    const lines = [
      entry.actorId ? `**Actor:** <@${entry.actorId}>` : null,
      entry.targetId ? `**Target:** <@${entry.targetId}> (\`${entry.targetId}\`)` : null,
      `**Result:** ${entry.result}`,
      entry.details ? `\`\`\`json\n${JSON.stringify(entry.details).slice(0, 900)}\n\`\`\`` : null,
    ].filter(Boolean);
    const e = make(`${category} • ${entry.action}`, lines.join('\n')).setTimestamp(entry.at);
    return send(guildId, category, { embeds: [e] });
  }

  /**
   * Alert staff about something that needs a human. Order: security log channel -> system channel -> guild owner DM.
   * @returns {Promise<{delivered:boolean, via:string|null}>}
   */
  async function alertStaff(guild, { title, description, severity = 'warn' }) {
    const make = severity === 'error' ? embed.error : severity === 'success' ? embed.success : embed.warn;
    const payload = { embeds: [make(title, description)] };
    const viaLog = await send(guild.id, 'security', payload);
    if (viaLog.sent) return { delivered: true, via: 'log-channel' };
    const sys = guild.systemChannel;
    if (sys) {
      const r = await sendToChannel(guild, sys.id, payload, 'alerts:system-channel');
      if (r.sent) return { delivered: true, via: 'system-channel' };
    }
    try {
      const owner = await guild.fetchOwner();
      await owner.send(payload);
      return { delivered: true, via: 'owner-dm' };
    } catch {
      return { delivered: false, via: null };
    }
  }

  /** DM every Super Admin (used for failures that need the bot operator). */
  async function alertSuperAdmins(superAdminIds, payload) {
    const client = getClient();
    let delivered = 0;
    for (const id of superAdminIds) {
      try {
        const u = await client.users.fetch(id);
        await u.send(payload);
        delivered += 1;
      } catch (err) {
        logger.warn('[ALERT] could not DM super admin', { error: err, userId: id });
      }
    }
    return { delivered };
  }

  return { getSettings, listSettings, setSettings, isEnabled, send, sendTo: sendToChannel, sink, alertStaff, alertSuperAdmins };
}

module.exports = { createLogDispatcher };
