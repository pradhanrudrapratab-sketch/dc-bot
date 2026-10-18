'use strict';
const { Events, AuditLogEvent, ChannelType } = require('discord.js');
const { planHoneypotOverwrites, buildNotice } = require('../../services/honeypot');
const logger = require('../../utils/logger');

const ACTIONS = new Map([
  [AuditLogEvent.ChannelDelete, 'channel_delete'],
  [AuditLogEvent.RoleDelete, 'role_delete'],
  [AuditLogEvent.MemberKick, 'member_kick'],
  [AuditLogEvent.MemberBanAdd, 'member_ban'],
]);

/**
 * guildAuditLogEntryCreate gives Discord's own executor for each action, so anti-nuke, bot guard and
 * honeypot tamper detection never guess an actor from timing. Requires the View Audit Log permission.
 */
module.exports = {
  name: Events.GuildAuditLogEntryCreate,
  async execute(c, entry, guild) {
    const executorId = entry.executorId ?? entry.executor?.id ?? null;
    const settings = await c.guildSettings.get(guild.id);

    // Anti-nuke
    const action = ACTIONS.get(entry.action);
    if (action && settings.antinuke_enabled) {
      await c.antiNuke.handleEntry({ guild, settings, action, executorId, targetId: entry.targetId });
    }

    // Unauthorized bot additions
    if (entry.action === AuditLogEvent.BotAdd && settings.botguard_enabled) {
      await c.botGuard.handleBotAdded({ guild, settings, botUserId: entry.targetId, executorId });
    }

    // Honeypot channel deleted
    if (entry.action === AuditLogEvent.ChannelDelete && settings.honeypot_enabled && entry.targetId === settings.honeypot_channel_id) {
      const authorized = new Set([guild.ownerId, ...c.config.bot.superAdmins, ...(await c.botGuard.list(guild.id)).map((r) => r.user_id)]);
      await c.honeypot.handleChannelDeleted({
        guild, settings, executorId, authorizedIds: authorized,
        createChannel: () => guild.channels.create({
          name: 'honey-trap', type: ChannelType.GuildText, reason: 'Honeypot channel restored',
          permissionOverwrites: planHoneypotOverwrites({ everyoneId: guild.roles.everyone.id, verifiedRoleId: settings.verification_enabled ? settings.verification_role_id : null, botId: guild.members.me.id })
            .map((o) => ({ id: o.id, allow: o.allow, deny: o.deny })),
        }),
        onRecreated: async (channel) => {
          await c.guildSettings.update(guild.id, { honeypot_channel_id: channel.id, honeypot_message_id: null });
          const m = await channel.send({ embeds: [buildNotice()] });
          await c.guildSettings.update(guild.id, { honeypot_message_id: m.id });
        },
      });
    }

    // Verification dependencies removed: tell staff once, with the fix.
    if (settings.verification_enabled && ((entry.action === AuditLogEvent.ChannelDelete && entry.targetId === settings.verification_channel_id) || (entry.action === AuditLogEvent.RoleDelete && entry.targetId === settings.verification_role_id))) {
      await c.logs.alertStaff(guild, { title: 'Verification dependency deleted', description: `The verification ${entry.action === AuditLogEvent.RoleDelete ? 'role' : 'channel'} was deleted${executorId ? ` by <@${executorId}>` : ''}. Verification cannot work until an admin runs \`/verification repair\` or \`/verification setup\`.`, severity: 'error' });
    }

    // Moderation log for kicks/bans performed by humans in Discord's UI
    if (action === 'member_kick' || action === 'member_ban') {
      if (executorId && executorId !== guild.members.me.id) {
        await c.audit.record({ guildId: guild.id, category: 'moderation', action: action === 'member_ban' ? 'ban_observed' : 'kick_observed', actorId: executorId, targetId: entry.targetId, details: { reason: entry.reason ?? null } })
          .catch((e) => logger.warn('[AUDIT] observed action not recorded', { error: e }));
      }
    }
  },
};
