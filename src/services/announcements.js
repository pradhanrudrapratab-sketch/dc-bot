'use strict';
const logger = require('../utils/logger');
const { classifyDiscordError } = require('./permissions');

const MAX_FILE_BYTES = 8 * 1024 * 1024;

/**
 * Master-channel announcement relay. Idempotent per (source message, destination guild) via a unique
 * row; copies are posted as the bot with mentions disabled; the bot's own copies are never relayed.
 */
function createAnnouncements({ db, settings, now = () => Date.now() }) {
  const SRC_GUILD = 'announce_source_guild';
  const SRC_CHANNEL = 'announce_source_channel';

  const getSource = async () => ({ guildId: await settings.getGlobal(SRC_GUILD), channelId: await settings.getGlobal(SRC_CHANNEL) });
  async function setSource(guildId, channelId) { await settings.setGlobal(SRC_GUILD, guildId); await settings.setGlobal(SRC_CHANNEL, channelId); }
  async function clearSource() { await settings.deleteGlobal(SRC_GUILD); await settings.deleteGlobal(SRC_CHANNEL); }

  /** Pure: is this message eligible for relay? */
  function isEligible(msg, source, botId) {
    if (!source.guildId || !source.channelId) return false;
    if (msg.guildId !== source.guildId || msg.channelId !== source.channelId) return false;
    if (msg.authorId === botId) return false;
    if (msg.webhookId || msg.system) return false;
    return true;
  }

  const destinations = async () => (await db.query('SELECT guild_id, announcement_channel_id FROM guild_settings WHERE announcement_channel_id IS NOT NULL')).rows;

  /** Build the outgoing payload from a plain message summary. Mentions are always disabled. */
  function buildPayload(msg) {
    let budget = MAX_FILE_BYTES;
    const files = [];
    const overflow = [];
    for (const a of msg.attachments || []) {
      if ((a.size ?? 0) <= budget) { files.push({ attachment: a.url, name: a.name }); budget -= a.size ?? 0; } else overflow.push(a.url);
    }
    const content = [msg.content, ...overflow].filter(Boolean).join('\n').slice(0, 2000);
    return { content: content || undefined, embeds: (msg.embeds || []).slice(0, 10), files, allowedMentions: { parse: [] } };
  }

  /**
   * @param {object} msg plain summary {id, content, attachments, embeds}
   * @param {(guildId:string, channelId:string, payload:object)=>Promise<void>} send performs the Discord send
   */
  async function relay(msg, send) {
    const payload = buildPayload(msg);
    const results = [];
    for (const d of await destinations()) {
      const ins = await db.query(
        `INSERT INTO announcement_deliveries (source_message_id, guild_id, channel_id, status, attempts, created_at)
         VALUES ($1, $2, $3, 'PENDING', 0, $4) ON CONFLICT (source_message_id, guild_id) DO NOTHING RETURNING id`,
        [msg.id, d.guild_id, d.announcement_channel_id, now()]);
      if (!ins.rows[0]) {
        const ex = (await db.query('SELECT status FROM announcement_deliveries WHERE source_message_id = $1 AND guild_id = $2', [msg.id, d.guild_id])).rows[0];
        if (ex.status === 'SENT') { results.push({ guildId: d.guild_id, status: 'SKIPPED_DUPLICATE' }); continue; }
      }
      try {
        await send(d.guild_id, d.announcement_channel_id, payload);
        await db.query(`UPDATE announcement_deliveries SET status = 'SENT', attempts = attempts + 1, delivered_at = $1, error = NULL WHERE source_message_id = $2 AND guild_id = $3`, [now(), msg.id, d.guild_id]);
        results.push({ guildId: d.guild_id, status: 'SENT' });
      } catch (err) {
        const kind = classifyDiscordError(err);
        logger.warn('[ANNOUNCE] delivery failed', { guildId: d.guild_id, kind });
        await db.query(`UPDATE announcement_deliveries SET status = 'FAILED', attempts = attempts + 1, error = $1 WHERE source_message_id = $2 AND guild_id = $3`, [kind, msg.id, d.guild_id]);
        results.push({ guildId: d.guild_id, status: 'FAILED', error: kind });
      }
    }
    return results;
  }

  return { getSource, setSource, clearSource, isEligible, buildPayload, relay, destinations };
}

module.exports = { createAnnouncements, MAX_FILE_BYTES };
