'use strict';
const { defineCommand } = require('../../framework/command');
const { embed } = require('../../utils/embeds');
const { eph, err, textChannel, cfgAudit, missingIn } = require('../_util');

const setannouncement = defineCommand({
  name: 'setannouncement', description: 'Receive global announcements in this (or a chosen) channel', category: 'announcements', userPermissions: ['Administrator'],
  options: [{ name: 'channel', type: 'channel', description: 'Channel (defaults to the current one)' }],
  async execute(ctx) {
    const ch = await textChannel(ctx);
    if (!ch) return ctx.reply(err('Invalid Channel', 'Choose a text channel in this server.'));
    const missing = missingIn(ch, ctx.guild, ['ViewChannel', 'SendMessages', 'EmbedLinks']);
    if (missing.length) return ctx.reply(err('I Cannot Post There', `I need ${missing.join(', ')} in <#${ch.id}>.`));
    await ctx.deps.guildSettings.update(ctx.guildId, { announcement_channel_id: ch.id });
    await cfgAudit(ctx, 'announcement_channel_set', { channelId: ch.id });
    return ctx.reply({ embeds: [embed.success('Announcement Channel Set', `Global announcements will be posted in <#${ch.id}>.`)] });
  },
});

const announcement = defineCommand({
  name: 'announcement', description: 'Manage this server\'s announcement subscription', category: 'announcements', userPermissions: ['Administrator'],
  subcommands: {
    status: { description: 'Show the announcement channel', async execute(ctx) {
      const s = await ctx.deps.guildSettings.get(ctx.guildId);
      return ctx.reply(eph(embed.info('Announcements', s.announcement_channel_id ? `Delivering to <#${s.announcement_channel_id}>.` : 'Not subscribed. Use `setannouncement`.')));
    } },
    unset: { description: 'Stop receiving announcements', async execute(ctx) {
      await ctx.deps.guildSettings.update(ctx.guildId, { announcement_channel_id: null });
      await cfgAudit(ctx, 'announcement_channel_unset');
      return ctx.reply({ embeds: [embed.success('Unsubscribed', 'This server will no longer receive global announcements.')] });
    } },
  },
});

// Owner-only: which master channel is the announcement source.
const announcesource = defineCommand({
  name: 'announcesource', description: '[Owner] Configure the master announcement source channel', category: 'owner', ownerOnly: true,
  subcommands: {
    set: { description: 'Use this (or a chosen) channel as the source', options: [{ name: 'channel', type: 'channel', description: 'Channel (defaults to current)' }], async execute(ctx) {
      const ch = await textChannel(ctx);
      if (!ch) return ctx.reply(err('Invalid Channel', 'Choose a text channel in this server.'));
      await ctx.deps.announcements.setSource(ctx.guildId, ch.id);
      await cfgAudit(ctx, 'announcement_source_set', { channelId: ch.id });
      return ctx.reply({ embeds: [embed.success('Source Set', `Messages in <#${ch.id}> will be relayed to every subscribed server.`)], ephemeral: true });
    } },
    status: { description: 'Show the source and subscriber count', async execute(ctx) {
      const src = await ctx.deps.announcements.getSource();
      const n = (await ctx.deps.announcements.destinations()).length;
      return ctx.reply(eph(embed.owner('Announcement Source', `${src.channelId ? `<#${src.channelId}> in guild \`${src.guildId}\`` : '_not set_'}\nSubscribed servers: **${n}**`)));
    } },
    clear: { description: 'Stop relaying', async execute(ctx) {
      await ctx.deps.announcements.clearSource();
      await cfgAudit(ctx, 'announcement_source_cleared');
      return ctx.reply(eph(embed.success('Cleared', 'The relay is off.')));
    } },
  },
});

module.exports = { commands: [setannouncement, announcement, announcesource] };
