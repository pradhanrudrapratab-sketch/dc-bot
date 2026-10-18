'use strict';
const { defineCommand } = require('../../framework/command');
const { embed } = require('../../utils/embeds');
const { eph, err, textChannel, cfgAudit, missingIn } = require('../_util');

const invites = defineCommand({
  name: 'invites', description: 'Invite tracking and statistics', category: 'invites',
  subcommands: {
    setup: {
      description: 'Enable tracking and choose the invite-log channel', userPermissions: ['Administrator'],
      options: [{ name: 'channel', type: 'channel', description: 'Existing log channel' }, { name: 'create', type: 'boolean', description: 'Create #invite-logs' }],
      async execute(ctx) {
        if (!ctx.guild.members.me.permissions.has('ManageGuild')) return ctx.reply(err('Missing Permissions', 'Invite tracking needs **Manage Server** so I can read invite usage.'));
        let ch;
        if (ctx.options.create) {
          if (!ctx.guild.members.me.permissions.has('ManageChannels')) return ctx.reply(err('Missing Permissions', 'I need **Manage Channels** to create a channel.'));
          ch = await ctx.guild.channels.create({ name: 'invite-logs', reason: 'Invite tracking', permissionOverwrites: [{ id: ctx.guild.roles.everyone.id, deny: ['ViewChannel'] }, { id: ctx.guild.members.me.id, allow: ['ViewChannel', 'SendMessages', 'EmbedLinks'] }] });
        } else ch = await textChannel(ctx);
        if (!ch) return ctx.reply(err('Channel Needed', 'Pass a text `channel` or `create: true`.'));
        const missing = missingIn(ch, ctx.guild, ['ViewChannel', 'SendMessages', 'EmbedLinks']);
        if (missing.length) return ctx.reply(err('I Cannot Post There', `I need ${missing.join(', ')} in <#${ch.id}>.`));
        await ctx.deps.guildSettings.update(ctx.guildId, { invite_tracking_enabled: 1, invite_log_channel_id: ch.id });
        await ctx.deps.inviteTracker.refresh(ctx.guild);
        await cfgAudit(ctx, 'invite_tracking_enabled', { channelId: ch.id });
        return ctx.reply({ embeds: [embed.success('Invite Tracking On', `Logging joins to <#${ch.id}>. Attribution is only shown when it is unambiguous; otherwise **Unknown inviter**.`)] });
      },
    },
    enable: { description: 'Enable tracking', userPermissions: ['Administrator'], async execute(ctx) { return flip(ctx, 1); } },
    disable: { description: 'Disable tracking', userPermissions: ['Administrator'], async execute(ctx) { return flip(ctx, 0); } },
    leaderboard: {
      description: 'Top inviters by currently-present members',
      async execute(ctx) {
        const rows = await ctx.deps.inviteRepo.leaderboard(ctx.guildId, 10);
        const text = rows.length ? rows.map((r, i) => `**${i + 1}.** <@${r.inviterId}> — **${r.active}** active · ${r.total} total · ${r.departed} left`).join('\n') : '_No tracked invites yet._';
        return ctx.reply({ embeds: [embed.info('Invite Leaderboard', text)] });
      },
    },
    stats: {
      description: 'Invite statistics for a user', options: [{ name: 'user', type: 'user', description: 'User (defaults to you)' }],
      async execute(ctx) {
        const id = ctx.options.user || ctx.user.id;
        const s = await ctx.deps.inviteRepo.stats(ctx.guildId, id);
        return ctx.reply(eph(embed.info('Invite Stats', `<@${id}>\n**Active (still here):** ${s.active}\n**Total invited:** ${s.total}\n**Left:** ${s.departed}`)));
      },
    },
  },
});
async function flip(ctx, v) {
  const s = await ctx.deps.guildSettings.get(ctx.guildId);
  if (v && !s.invite_log_channel_id) return ctx.reply(err('Not Configured', 'Run `invites setup` first.'));
  await ctx.deps.guildSettings.update(ctx.guildId, { invite_tracking_enabled: v });
  if (v) await ctx.deps.inviteTracker.refresh(ctx.guild);
  await cfgAudit(ctx, v ? 'invite_tracking_enabled' : 'invite_tracking_disabled');
  return ctx.reply({ embeds: [embed.success('Invite Tracking', v ? 'Enabled.' : 'Disabled. Existing records are kept.')] });
}

module.exports = { commands: [invites] };
