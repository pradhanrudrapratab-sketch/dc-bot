'use strict';
const { classifyDiscordError } = require('./permissions');

/**
 * Who may add bots? Users on the guild allowlist AND holding Administrator. The server owner and
 * Super Admins are implicitly trusted (the owner cannot be banned anyway). Pure decision.
 */
function decideBotAdd({ botId, targetId, executorId, guildOwnerId, superAdmins, allowlisted, executorIsAdmin }) {
  if (targetId === botId) return { action: 'IGNORE', reason: 'SELF' };
  if (!executorId) return { action: 'UNATTRIBUTED' };
  if (executorId === botId) return { action: 'IGNORE', reason: 'SELF_ACTOR' };
  if (executorId === guildOwnerId || superAdmins.has(executorId)) return { action: 'AUTHORIZED', reason: 'TRUSTED' };
  if (allowlisted && executorIsAdmin) return { action: 'AUTHORIZED', reason: 'ALLOWLISTED_ADMIN' };
  return { action: 'UNAUTHORIZED', reason: allowlisted ? 'NOT_ADMIN' : 'NOT_ALLOWLISTED' };
}

function createBotGuard({ db, moderation, audit, logs, superAdmins, now = () => Date.now() }) {
  const isAllowed = async (guildId, userId) => (await db.query('SELECT 1 AS x FROM bot_access_allowlist WHERE guild_id = $1 AND user_id = $2', [guildId, userId])).rows.length > 0;
  const list = async (guildId) => (await db.query('SELECT user_id, added_by, added_at FROM bot_access_allowlist WHERE guild_id = $1 ORDER BY added_at', [guildId])).rows;
  async function add(guildId, userId, by) {
    const r = await db.query(`INSERT INTO bot_access_allowlist (guild_id, user_id, added_by, added_at) VALUES ($1, $2, $3, $4) ON CONFLICT (guild_id, user_id) DO NOTHING RETURNING user_id`, [guildId, userId, by, now()]);
    return r.rows.length > 0;
  }
  async function remove(guildId, userId) {
    return (await db.query('DELETE FROM bot_access_allowlist WHERE guild_id = $1 AND user_id = $2', [guildId, userId])).rowCount > 0;
  }

  /**
   * Handle a BotAdd audit entry (executorId from Discord, or null when attribution is unavailable).
   * Detection + response only: Discord offers no universal way to block an OAuth bot-add beforehand.
   */
  async function handleBotAdded({ guild, settings, botUserId, executorId }) {
    if (!settings?.botguard_enabled) return { handled: false, reason: 'DISABLED' };
    const allowlisted = executorId ? await isAllowed(guild.id, executorId) : false;
    let executorIsAdmin = false;
    if (executorId && allowlisted) {
      const m = await guild.members.fetch(executorId).catch(() => null);
      executorIsAdmin = !!m?.permissions.has('Administrator');
    }
    const d = decideBotAdd({ botId: guild.members.me.id, targetId: botUserId, executorId, guildOwnerId: guild.ownerId, superAdmins, allowlisted, executorIsAdmin });
    if (d.action === 'IGNORE' || d.action === 'AUTHORIZED') {
      if (d.action === 'AUTHORIZED') await audit.record({ guildId: guild.id, category: 'security', action: 'bot_added_authorized', actorId: executorId, targetId: botUserId, details: { reason: d.reason } });
      return { handled: false, reason: d.reason, decision: d.action };
    }

    const res = { handled: true, decision: d.action, executorId, botKicked: false, executorBanned: false, errors: [] };
    const kickBot = async () => {
      try { await guild.members.kick(botUserId, 'Unauthorized bot addition'); res.botKicked = true; } catch (err) { res.errors.push(`kick_bot:${classifyDiscordError(err)}`); }
    };
    if (d.action === 'UNAUTHORIZED') {
      await Promise.all([
        kickBot(),
        moderation.ban({ guild, targetId: executorId, reason: 'Added a bot without authorization', auto: true }).then((r) => {
          res.executorBanned = r.ok;
          if (!r.ok) res.errors.push(`ban:${r.code}`);
        }),
      ]);
    } else if (settings.botguard_fallback === 'kick_bot') {
      await kickBot(); // actor unknown: never guess who to ban
    }

    await audit.recordSecurityEvent({
      guildId: guild.id, eventType: 'unauthorized_bot_added', actorId: executorId, targetId: botUserId,
      evidence: { decision: d.action, reason: d.reason ?? null }, actionTaken: JSON.stringify({ botKicked: res.botKicked, executorBanned: res.executorBanned }), outcome: JSON.stringify(res.errors),
    });
    await logs.alertStaff(guild, {
      title: d.action === 'UNAUTHORIZED' ? 'Unauthorized bot added' : 'Bot added: adder could not be identified',
      description: [
        `Bot: <@${botUserId}>`,
        executorId ? `Added by: <@${executorId}> (${d.reason})` : 'Added by: **unknown** (no audit-log attribution; not guessed). Check that I have **View Audit Log**.',
        `Bot removed: ${res.botKicked ? 'yes' : 'no'}`,
        executorId ? `Adder banned: ${res.executorBanned ? 'yes' : 'no'}` : null,
        res.errors.length ? `Problems: ${res.errors.join(', ')}` : null,
      ].filter(Boolean).join('\n'),
      severity: res.errors.length ? 'error' : 'warn',
    }).catch(() => {});
    return res;
  }

  return { isAllowed, list, add, remove, handleBotAdded };
}

module.exports = { createBotGuard, decideBotAdd };
