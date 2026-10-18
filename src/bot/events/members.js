'use strict';
const { Events } = require('discord.js');
const { embed } = require('../../utils/embeds');
const logger = require('../../utils/logger');

module.exports = { events: [
  {
    name: Events.GuildMemberAdd,
    async execute(c, member) {
      const settings = await c.guildSettings.get(member.guild.id);
      if (settings.invite_tracking_enabled && !member.user.bot) {
        const r = await c.inviteTracker.handleJoin(member);
        if (settings.invite_log_channel_id && r.recorded) {
          const who = r.attribution === 'VANITY' ? 'the server\'s **vanity URL**' : r.inviterId ? `<@${r.inviterId}> (code \`${r.code}\`)` : '**Unknown inviter** (could not be determined reliably)';
          const created = member.user.createdTimestamp ? ` · account created <t:${Math.floor(member.user.createdTimestamp / 1000)}:R>` : '';
          await c.logs.sendTo(member.guild, settings.invite_log_channel_id, { embeds: [embed.info('Member Joined', `<@${member.id}> joined via ${who}${created}`)] }, 'invite-log').catch(() => {});
        }
      }
      if (await c.logs.isEnabled(member.guild.id, 'member')) {
        await c.logs.send(member.guild.id, 'member', { embeds: [embed.success('Member Joined', `<@${member.id}> (\`${member.id}\`)${member.user.bot ? ' 🤖 bot' : ''}\nAccount created <t:${Math.floor((member.user.createdTimestamp ?? Date.now()) / 1000)}:R>`)] });
      }
      // Bot added but we cannot see who added it (no audit-log access): apply the configured fallback.
      if (member.user.bot && settings.botguard_enabled && !member.guild.members.me.permissions.has('ViewAuditLog')) {
        await c.botGuard.handleBotAdded({ guild: member.guild, settings, botUserId: member.id, executorId: null });
      }
    },
  },
  {
    name: Events.GuildMemberRemove,
    async execute(c, member) {
      const closed = await c.inviteTracker.handleLeave(member.guild.id, member.id).catch((e) => { logger.warn('[INVITES] leave failed', { error: e }); return null; });
      if (await c.logs.isEnabled(member.guild.id, 'member')) {
        await c.logs.send(member.guild.id, 'member', { embeds: [embed.warn('Member Left', `<@${member.id}> (\`${member.id}\`)${closed?.inviter_id ? `\nPreviously invited by <@${closed.inviter_id}>` : ''}`)] });
      }
    },
  },
  {
    name: Events.GuildMemberUpdate,
    async execute(c, before, after) {
      if (!(await c.logs.isEnabled(after.guild.id, 'role'))) return;
      const added = after.roles.cache.filter((r) => !before.roles.cache.has(r.id));
      const removed = before.roles.cache.filter((r) => !after.roles.cache.has(r.id));
      if (!added.size && !removed.size) return;
      await c.logs.send(after.guild.id, 'role', { embeds: [embed.info('Member Roles Changed', `<@${after.id}>\n${added.size ? `➕ ${added.map((r) => `<@&${r.id}>`).join(' ')}\n` : ''}${removed.size ? `➖ ${removed.map((r) => `<@&${r.id}>`).join(' ')}` : ''}`)] });
    },
  },
  {
    name: Events.InviteCreate,
    async execute(c, invite) { c.inviteTracker.onInviteCreate(invite); },
  },
  {
    name: Events.InviteDelete,
    async execute(c, invite) { c.inviteTracker.onInviteDelete(invite); },
  },
] };
