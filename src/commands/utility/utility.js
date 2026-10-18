'use strict';
const { defineCommand } = require('../../framework/command');
const { embed } = require('../../utils/embeds');
const { validatePrefix } = require('../../services/guildSettings');
const { label } = require('../../framework/permissionNames');
const { cfgAudit } = require('../_util');

const setprefix = defineCommand({
  name: 'setprefix', description: 'Change the prefix for text commands in this server', category: 'utility', userPermissions: ['Administrator'],
  options: [{ name: 'prefix', type: 'string', description: 'New prefix (1-5 characters)', required: true, maxLength: 5 }],
  async execute(ctx) {
    const v = validatePrefix(ctx.options.prefix);
    if (!v.ok) return ctx.reply({ embeds: [embed.error('Invalid Prefix', v.error)], ephemeral: true });
    const old = await ctx.deps.guildSettings.getPrefix(ctx.guildId);
    await ctx.deps.guildSettings.update(ctx.guildId, { prefix: v.value });
    await cfgAudit(ctx, 'prefix_changed', { from: old, to: v.value });
    return ctx.reply({ embeds: [embed.success('Prefix Updated', `Text commands now use \`${v.value}\` (was \`${old}\`). Slash commands are unchanged.`)] });
  },
});

const help = defineCommand({
  name: 'help', description: 'List the bot\'s commands', category: 'utility', guildOnly: false,
  async execute(ctx) {
    const prefix = ctx.guildId ? await ctx.deps.guildSettings.getPrefix(ctx.guildId) : '!';
    const groups = new Map();
    for (const c of ctx.deps.registry.all) {
      if (c.ownerOnly && !ctx.deps.config.bot.superAdmins.has(ctx.user.id)) continue;
      const tags = [c.slash ? '/' : '', c.prefix ? prefix : ''].filter(Boolean).join(' ');
      const subs = c.subcommands ? ` <${Object.keys(c.subcommands).join('|')}>` : '';
      const line = `\`${c.slash ? '/' : prefix}${c.prefixNames && !c.slash ? c.prefixNames[0] : c.name}${subs}\` — ${c.description}${c.slash && c.prefix ? ` _(${tags})_` : ''}`;
      if (!groups.has(c.category)) groups.set(c.category, []);
      groups.get(c.category).push(line);
    }
    const e = embed.info('DC Bot Commands', `Prefix here: \`${prefix}\` · slash commands work everywhere`);
    for (const [cat, lines] of groups) e.addFields({ name: cat[0].toUpperCase() + cat.slice(1), value: lines.join('\n').slice(0, 1020) });
    return ctx.reply({ embeds: [e], ephemeral: true });
  },
});

const FEATURE_PERMS = {
  Moderation: ['BanMembers', 'KickMembers', 'ModerateMembers', 'ManageMessages'],
  'Verification / roles': ['ManageRoles', 'ManageChannels'],
  'Honeypot / anti-nuke / bot guard': ['ViewAuditLog', 'BanMembers', 'ManageChannels', 'KickMembers'],
  'Invite tracking': ['ManageGuild'],
  'Emoji stealer': ['ManageGuildExpressions'],
  'Logging / announcements': ['ViewChannel', 'SendMessages', 'EmbedLinks'],
};

const permcheck = defineCommand({
  name: 'permcheck', description: 'Check which features are blocked by missing bot permissions', category: 'utility', userPermissions: ['Administrator'],
  async execute(ctx) {
    const me = ctx.guild.members.me;
    const lines = Object.entries(FEATURE_PERMS).map(([feature, perms]) => {
      const missing = perms.filter((p) => !me.permissions.has(p));
      return missing.length ? `❌ **${feature}** — missing ${missing.map(label).join(', ')}` : `✅ **${feature}**`;
    });
    const blocked = await ctx.deps.permissionMonitor.listBlocked(ctx.guildId);
    const extra = blocked.length ? `\n\n**Currently reported blocked:** ${blocked.map((b) => `${b.feature} (${b.missing})`).join(', ')}` : '';
    return ctx.reply({ embeds: [embed.info('Permission Check', `${lines.join('\n')}${extra}\n\n_Missing permissions only disable the affected feature. Role position also matters: my highest role must be above any role I manage or moderate._`)], ephemeral: true });
  },
});

module.exports = { commands: [setprefix, help, permcheck], FEATURE_PERMS };
