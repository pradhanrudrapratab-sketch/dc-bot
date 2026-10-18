'use strict';
const { defineCommand } = require('../../framework/command');
const { embed } = require('../../utils/embeds');
const { buildNotice, planHoneypotOverwrites } = require('../../services/honeypot');
const { label } = require('../../framework/permissionNames');
const { eph, err, isTrusted, textChannel, cfgAudit } = require('../_util');

const chOpt = { name: 'channel', type: 'channel', description: 'Existing channel' };
const onOff = (v) => (v ? '🟢 enabled' : '⚪ disabled');
const REQ = ['ViewAuditLog', 'BanMembers', 'ManageChannels'];

/* ───────── honeypot ───────── */
async function ensureNotice(channel, settings, deps, guildId) {
  const prev = settings.honeypot_message_id ? await channel.messages.fetch(settings.honeypot_message_id).catch(() => null) : null;
  if (prev && prev.author.id === channel.client.user.id) { await prev.edit({ embeds: [buildNotice()] }); return prev.id; } // no duplicate notices
  const m = await channel.send({ embeds: [buildNotice()] });
  await deps.guildSettings.update(guildId, { honeypot_message_id: m.id });
  return m.id;
}

const honeypot = defineCommand({
  name: 'honeypot', description: 'Configure the honeypot security channel', category: 'security', userPermissions: ['Administrator'],
  subcommands: {
    setup: {
      description: 'Use an existing channel or create one as the honeypot',
      options: [chOpt, { name: 'create', type: 'boolean', description: 'Create a new #honey-trap channel' }],
      async execute(ctx) {
        const { guildSettings } = ctx.deps;
        const settings = await guildSettings.get(ctx.guildId);
        const me = ctx.guild.members.me;
        const missing = REQ.filter((p) => !me.permissions.has(p));
        if (missing.length) return ctx.reply(err('Missing Permissions', `Honeypot needs ${missing.map((p) => `**${label(p)}**`).join(', ')}. Grant them and retry.`));
        let channel;
        if (ctx.options.create) {
          const ows = planHoneypotOverwrites({ everyoneId: ctx.guild.roles.everyone.id, verifiedRoleId: settings.verification_enabled ? settings.verification_role_id : null, botId: me.id });
          channel = await ctx.guild.channels.create({ name: 'honey-trap', reason: 'Honeypot setup', permissionOverwrites: ows.map((o) => ({ id: o.id, allow: o.allow, deny: o.deny })) });
        } else if (ctx.options.channel) {
          channel = await textChannel(ctx);
          if (!channel) return ctx.reply(err('Invalid Channel', 'Choose a text channel in this server.'));
        } else return ctx.reply(err('Choose a Channel', 'Pass `channel` or `create: true`.'));
        await guildSettings.update(ctx.guildId, { honeypot_channel_id: channel.id, honeypot_enabled: 1, honeypot_message_id: null });
        await ensureNotice(channel, { honeypot_message_id: null }, ctx.deps, ctx.guildId);
        await cfgAudit(ctx, 'honeypot_setup', { channelId: channel.id, created: !!ctx.options.create });
        const audience = ctx.options.create && settings.verification_enabled ? 'Unverified members can see and post here; verified members cannot see it.' : 'Anyone who can see AND send in this channel will be banned if they post. Make sure only the intended audience (e.g. unverified members) can see it.';
        return ctx.reply({ embeds: [embed.success('Honeypot Active', `Channel: <#${channel.id}>\nAny non-bot message there triggers a **ban** with a request to delete the sender's last 7 days of messages.\n\n**Audience:** ${audience}`)] });
      },
    },
    enable: { description: 'Enable the honeypot', async execute(ctx) { return toggle(ctx, 1); } },
    disable: { description: 'Disable the honeypot', async execute(ctx) { return toggle(ctx, 0); } },
    tamper: {
      description: 'Action when an unauthorized user deletes the honeypot channel',
      options: [{ name: 'action', type: 'string', description: 'alert or ban', required: true, choices: ['alert', 'ban'] }],
      async execute(ctx) {
        await ctx.deps.guildSettings.update(ctx.guildId, { honeypot_tamper_action: ctx.options.action });
        await cfgAudit(ctx, 'honeypot_tamper_action', { action: ctx.options.action });
        return ctx.reply({ embeds: [embed.success('Updated', `Deleting the honeypot channel without authorization now: **${ctx.options.action}** (the channel is always recreated if I can).`)] });
      },
    },
    status: {
      description: 'Show honeypot configuration and readiness',
      async execute(ctx) {
        const s = await ctx.deps.guildSettings.get(ctx.guildId);
        const me = ctx.guild.members.me;
        const missing = REQ.filter((p) => !me.permissions.has(p));
        return ctx.reply(eph(embed.info('Honeypot Status', [`State: ${onOff(s.honeypot_enabled)}`, `Channel: ${s.honeypot_channel_id ? `<#${s.honeypot_channel_id}>` : '_not set_'}`, `Tamper action: **${s.honeypot_tamper_action}**`, missing.length ? `⚠️ Degraded — missing ${missing.map(label).join(', ')}` : '✅ Required permissions present'].join('\n'))));
      },
    },
  },
});
async function toggle(ctx, v) {
  const s = await ctx.deps.guildSettings.get(ctx.guildId);
  if (v && !s.honeypot_channel_id) return ctx.reply(err('Not Configured', 'Run `honeypot setup` first.'));
  await ctx.deps.guildSettings.update(ctx.guildId, { honeypot_enabled: v });
  await cfgAudit(ctx, v ? 'honeypot_enabled' : 'honeypot_disabled');
  return ctx.reply({ embeds: [embed.success('Honeypot Updated', `Honeypot is now ${onOff(v)}.`)] });
}

/* ───────── bot access allowlist ───────── */
const userRequired = { name: 'user', type: 'user', description: 'User', required: true };
const botaccess = defineCommand({
  name: 'botaccess', description: 'Manage who may add bots to this server', category: 'security', userPermissions: ['Administrator'],
  subcommands: {
    add: { description: 'Allow a user (who is also an Administrator) to add bots', options: [userRequired], async execute(ctx) {
      if (!isTrusted(ctx)) return ctx.reply(err('Not Allowed', 'Only the server owner or a bot Super Admin can change the allowlist.'));
      const added = await ctx.deps.botGuard.add(ctx.guildId, ctx.options.user, ctx.user.id);
      await cfgAudit(ctx, 'botaccess_add', { userId: ctx.options.user, added }, { targetId: ctx.options.user });
      return ctx.reply({ embeds: [embed.success('Allowlist Updated', added ? `<@${ctx.options.user}> may add bots (only while they hold Administrator).` : 'Already on the allowlist.')] });
    } },
    remove: { description: 'Remove a user from the allowlist', options: [userRequired], async execute(ctx) {
      if (!isTrusted(ctx)) return ctx.reply(err('Not Allowed', 'Only the server owner or a bot Super Admin can change the allowlist.'));
      const removed = await ctx.deps.botGuard.remove(ctx.guildId, ctx.options.user);
      await cfgAudit(ctx, 'botaccess_remove', { userId: ctx.options.user, removed }, { targetId: ctx.options.user });
      return ctx.reply({ embeds: [embed.success('Allowlist Updated', removed ? `<@${ctx.options.user}> can no longer add bots. Their Administrator role was **not** changed.` : 'They were not on the allowlist.')] });
    } },
    list: { description: 'Show the allowlist', async execute(ctx) {
      const rows = await ctx.deps.botGuard.list(ctx.guildId);
      return ctx.reply(eph(embed.info('Bot Allowlist', rows.length ? rows.map((r) => `<@${r.user_id}> — added by <@${r.added_by}> <t:${Math.floor(r.added_at / 1000)}:R>`).join('\n') : '_Empty: only the server owner and Super Admins may add bots._')));
    } },
    enable: { description: 'Turn on unauthorized-bot detection', async execute(ctx) {
      const me = ctx.guild.members.me;
      const missing = ['ViewAuditLog', 'BanMembers', 'KickMembers'].filter((p) => !me.permissions.has(p));
      await ctx.deps.guildSettings.update(ctx.guildId, { botguard_enabled: 1 });
      await cfgAudit(ctx, 'botguard_enabled');
      return ctx.reply({ embeds: [(missing.length ? embed.warn : embed.success)('Bot Guard Enabled', `Unauthorized bot additions are detected after the fact (Discord offers no pre-add block): the bot is removed and the adder banned.${missing.length ? `\n\n⚠️ Degraded until I have: ${missing.map(label).join(', ')}.` : ''}`)] });
    } },
    disable: { description: 'Turn off unauthorized-bot detection', async execute(ctx) {
      await ctx.deps.guildSettings.update(ctx.guildId, { botguard_enabled: 0 });
      await cfgAudit(ctx, 'botguard_disabled');
      return ctx.reply({ embeds: [embed.success('Bot Guard Disabled', 'Detection is off.')] });
    } },
    fallback: { description: 'What to do when the adder cannot be identified', options: [{ name: 'mode', type: 'string', description: 'alert or kick_bot', required: true, choices: ['alert', 'kick_bot'] }], async execute(ctx) {
      await ctx.deps.guildSettings.update(ctx.guildId, { botguard_fallback: ctx.options.mode });
      await cfgAudit(ctx, 'botguard_fallback', { mode: ctx.options.mode });
      return ctx.reply({ embeds: [embed.success('Updated', `If the adder is unknown I will **${ctx.options.mode === 'alert' ? 'only alert staff' : 'remove the bot and alert staff'}** (I never ban a guessed user).`)] });
    } },
  },
});

/* ───────── anti-nuke ───────── */
const antinuke = defineCommand({
  name: 'antinuke', description: 'Anti-nuke protection (>3 destructive actions in 60s)', category: 'security', userPermissions: ['Administrator'],
  subcommands: {
    enable: { description: 'Enable anti-nuke', async execute(ctx) {
      const missing = REQ.filter((p) => !ctx.guild.members.me.permissions.has(p));
      await ctx.deps.guildSettings.update(ctx.guildId, { antinuke_enabled: 1 });
      await cfgAudit(ctx, 'antinuke_enabled');
      return ctx.reply({ embeds: [(missing.length ? embed.warn : embed.success)('Anti-Nuke Enabled', `Watching channel deletions, role deletions and kicks/bans (separately, >3 per 60s per person). The actor is identified from the Audit Log, never guessed.${missing.length ? `\n\n⚠️ Degraded until I have: ${missing.map(label).join(', ')}.` : ''}`)] });
    } },
    disable: { description: 'Disable anti-nuke', async execute(ctx) {
      if (!isTrusted(ctx)) return ctx.reply(err('Not Allowed', 'Only the server owner or a bot Super Admin can disable anti-nuke.'));
      await ctx.deps.guildSettings.update(ctx.guildId, { antinuke_enabled: 0 });
      await cfgAudit(ctx, 'antinuke_disabled');
      return ctx.reply({ embeds: [embed.success('Anti-Nuke Disabled', 'Protection is off.')] });
    } },
    status: { description: 'Show anti-nuke status', async execute(ctx) {
      const s = await ctx.deps.guildSettings.get(ctx.guildId);
      const missing = REQ.filter((p) => !ctx.guild.members.me.permissions.has(p));
      return ctx.reply(eph(embed.info('Anti-Nuke Status', `State: ${onOff(s.antinuke_enabled)}\nLimit: >3 per type per 60s\n${missing.length ? `⚠️ Degraded — missing ${missing.map(label).join(', ')}` : '✅ Required permissions present'}`)));
    } },
    allow: { description: 'Trust a user (exempt from anti-nuke)', options: [userRequired], async execute(ctx) {
      if (!isTrusted(ctx)) return ctx.reply(err('Not Allowed', 'Only the server owner or a bot Super Admin can change the allowlist.'));
      await ctx.deps.antiNuke.addAllowlist(ctx.guildId, ctx.options.user, ctx.user.id);
      await cfgAudit(ctx, 'antinuke_allow', { userId: ctx.options.user }, { targetId: ctx.options.user });
      return ctx.reply({ embeds: [embed.success('Trusted', `<@${ctx.options.user}> is exempt from anti-nuke.`)] });
    } },
    unallow: { description: 'Remove a trusted user', options: [userRequired], async execute(ctx) {
      if (!isTrusted(ctx)) return ctx.reply(err('Not Allowed', 'Only the server owner or a bot Super Admin can change the allowlist.'));
      const r = await ctx.deps.antiNuke.removeAllowlist(ctx.guildId, ctx.options.user);
      await cfgAudit(ctx, 'antinuke_unallow', { userId: ctx.options.user, removed: r }, { targetId: ctx.options.user });
      return ctx.reply({ embeds: [embed.success('Updated', r ? `<@${ctx.options.user}> is no longer exempt.` : 'They were not on the list.')] });
    } },
    list: { description: 'Show trusted users', async execute(ctx) {
      const rows = await ctx.deps.antiNuke.allowlist(ctx.guildId);
      return ctx.reply(eph(embed.info('Anti-Nuke Allowlist', rows.length ? rows.map((r) => `<@${r.user_id}>`).join('\n') : '_Empty (the owner and Super Admins are always exempt)._')));
    } },
  },
});

module.exports = { commands: [honeypot, botaccess, antinuke] };
