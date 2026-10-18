'use strict';
const { defineCommand } = require('../../framework/command');
const { embed } = require('../../utils/embeds');
const { LOG_CATEGORIES } = require('../../services/audit');
const { eph, err, textChannel, cfgAudit, missingIn } = require('../_util');

const cat = { name: 'category', type: 'string', description: 'Log category', required: true, choices: [...LOG_CATEGORIES, 'all'] };
const NEED = ['ViewChannel', 'SendMessages', 'EmbedLinks'];
const cats = (c) => (c === 'all' ? LOG_CATEGORIES : [c]);

const log = defineCommand({
  name: 'log', description: 'Configure audit logging channels and categories', category: 'logging', userPermissions: ['Administrator'],
  subcommands: {
    set: {
      description: 'Send a category to a channel (existing, or create a new one)',
      options: [cat, { name: 'channel', type: 'channel', description: 'Existing channel' }, { name: 'create', type: 'boolean', description: 'Create a new log channel' }],
      async execute(ctx) {
        let channel;
        if (ctx.options.create) {
          if (!ctx.guild.members.me.permissions.has('ManageChannels')) return ctx.reply(err('Missing Permissions', 'I need **Manage Channels** to create a log channel.'));
          const name = `${ctx.options.category === 'all' ? 'server' : ctx.options.category}-logs`;
          // private by default: only admins and the bot can see audit content
          channel = await ctx.guild.channels.create({ name, reason: 'Log channel', permissionOverwrites: [
            { id: ctx.guild.roles.everyone.id, deny: ['ViewChannel'] },
            { id: ctx.guild.members.me.id, allow: ['ViewChannel', 'SendMessages', 'EmbedLinks'] },
          ] });
        } else channel = await textChannel(ctx);
        if (!channel) return ctx.reply(err('Channel Needed', 'Pass a text `channel` or `create: true`.'));
        const missing = missingIn(channel, ctx.guild, NEED);
        if (missing.length) return ctx.reply(err('I Cannot Post There', `I need ${missing.join(', ')} in <#${channel.id}>.`));
        for (const c of cats(ctx.options.category)) await ctx.deps.logs.setSettings(ctx.guildId, c, { channelId: channel.id, enabled: true });
        await cfgAudit(ctx, 'log_channel_set', { category: ctx.options.category, channelId: channel.id });
        return ctx.reply({ embeds: [embed.success('Logging Configured', `**${ctx.options.category}** → <#${channel.id}> (enabled).\n_Log channels may contain private message content. Keep them staff-only._`)] });
      },
    },
    enable: { description: 'Enable a category', options: [cat], async execute(ctx) { return flip(ctx, true); } },
    disable: { description: 'Disable a category', options: [cat], async execute(ctx) { return flip(ctx, false); } },
    status: {
      description: 'Show logging configuration',
      async execute(ctx) {
        const rows = new Map((await ctx.deps.logs.listSettings(ctx.guildId)).map((r) => [r.category, r]));
        const lines = LOG_CATEGORIES.map((c) => { const r = rows.get(c); return `${r?.enabled ? '🟢' : '⚪'} **${c}** → ${r?.channel_id ? `<#${r.channel_id}>` : '_no channel_'}`; });
        const blocked = await ctx.deps.permissionMonitor.listBlocked(ctx.guildId);
        const bad = blocked.filter((b) => b.feature.startsWith('log:'));
        return ctx.reply(eph(embed.info('Logging Status', `${lines.join('\n')}${bad.length ? `\n\n⚠️ Degraded: ${bad.map((b) => `${b.feature} (${b.missing})`).join(', ')}` : ''}\n\n_Deleted/edited message content is only available for messages I saw while running (in-memory cache); nothing is stored persistently._`)));
      },
    },
  },
});

async function flip(ctx, enabled) {
  const out = [];
  for (const c of cats(ctx.options.category)) {
    const s = await ctx.deps.logs.getSettings(ctx.guildId, c);
    if (enabled && !s?.channel_id) { out.push(`${c}: no channel set`); continue; }
    await ctx.deps.logs.setSettings(ctx.guildId, c, { enabled });
    out.push(`${c}: ${enabled ? 'enabled' : 'disabled'}`);
  }
  await cfgAudit(ctx, enabled ? 'log_enabled' : 'log_disabled', { category: ctx.options.category });
  return ctx.reply({ embeds: [embed.success('Logging Updated', out.join('\n'))] });
}

module.exports = { commands: [log] };
