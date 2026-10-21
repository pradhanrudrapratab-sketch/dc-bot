'use strict';
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { defineCommand } = require('../../framework/command');
const { embed } = require('../../utils/embeds');
const { planLockdown, serializeLockdown, parseLockdown, overwriteState, stateToValue } = require('../../services/verification');
const { label } = require('../../framework/permissionNames');
const { eph, err, textChannel, cfgAudit } = require('../_util');

const REQ = ['ManageRoles', 'ManageChannels'];
const VERIFY_ID = 'verify:grant';

const verifyMessage = () => ({
  embeds: [embed.brand('✅ Verify to enter', 'Welcome! Press **Verify** to unlock the rest of the server.\nBy verifying you agree to follow the server rules.')],
  components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(VERIFY_ID).setLabel('Verify').setStyle(ButtonStyle.Success))],
});

async function postVerifyMessage(channel, settings, guildSettings, guildId) {
  const prev = settings.verification_message_id ? await channel.messages.fetch(settings.verification_message_id).catch(() => null) : null;
  if (prev && prev.author.id === channel.client.user.id) { await prev.edit(verifyMessage()); return prev.id; } // never a duplicate panel
  const m = await channel.send(verifyMessage());
  await guildSettings.update(guildId, { verification_message_id: m.id });
  return m.id;
}

/** Ask the invoking admin to confirm, then run `fn` (permissions re-checked at action time). */
async function confirm(ctx, { title, text, fn }) {
  const id = ctx.deps.confirmations.create({
    userId: ctx.user.id, guildId: ctx.guildId, description: title,
    run: async (i) => {
      if (!i.memberPermissions?.has('Administrator')) return i.update({ embeds: [embed.error('Missing Permissions', 'You no longer have Administrator.')], components: [] });
      await i.deferUpdate();
      const result = await fn();
      return i.editReply({ embeds: [embed.success(title, result)], components: [] });
    },
  });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`cf:${id}:y`).setLabel('Confirm').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`cf:${id}:n`).setLabel('Cancel').setStyle(ButtonStyle.Secondary));
  return ctx.reply({ embeds: [embed.warn(title, `${text}\n\nThis confirmation expires in 60 seconds.`)], components: [row], ephemeral: true });
}

const verification = defineCommand({
  name: 'verification', description: 'Configure member verification', category: 'verification', userPermissions: ['Administrator'],
  subcommands: {
    setup: {
      description: 'Set the verified role and verification channel',
      options: [
        { name: 'role', type: 'role', description: 'Existing verified role' },
        { name: 'create_role', type: 'boolean', description: 'Create a "Verified" role' },
        { name: 'channel', type: 'channel', description: 'Existing verification channel' },
        { name: 'create_channel', type: 'boolean', description: 'Create a #verification channel' },
      ],
      async execute(ctx) {
        const me = ctx.guild.members.me;
        const missing = REQ.filter((p) => !me.permissions.has(p));
        if (missing.length) return ctx.reply(err('Missing Permissions', `Verification setup needs ${missing.map((p) => `**${label(p)}**`).join(', ')}.`));
        let role = ctx.options.role ? await ctx.guild.roles.fetch(ctx.options.role).catch(() => null) : null;
        if (!role && ctx.options.create_role) role = await ctx.guild.roles.create({ name: 'Verified', reason: 'Verification setup' });
        if (!role) return ctx.reply(err('Role Needed', 'Pass `role` or `create_role: true`.'));
        if (role.id === ctx.guild.id || role.managed || role.position >= me.roles.highest.position) {
          return ctx.reply(err('Role Not Usable', 'That role is @everyone, bot-managed, or at/above my highest role. Pick another or move my role up.'));
        }
        let channel;
        if (ctx.options.channel) channel = await textChannel(ctx);
        else if (ctx.options.create_channel) {
          channel = await ctx.guild.channels.create({
            name: 'verification', reason: 'Verification setup',
            permissionOverwrites: [
              { id: ctx.guild.roles.everyone.id, allow: ['ViewChannel', 'ReadMessageHistory'], deny: ['SendMessages'] },
              { id: me.id, allow: ['ViewChannel', 'SendMessages', 'EmbedLinks'] },
              { id: role.id, deny: ['ViewChannel'] },
            ],
          });
        }
        if (!channel) return ctx.reply(err('Channel Needed', 'Pass a text `channel` or `create_channel: true`.'));
        const gs = ctx.deps.guildSettings;
        await gs.update(ctx.guildId, { verification_role_id: role.id, verification_channel_id: channel.id, verification_enabled: 1, verification_message_id: null });
        await postVerifyMessage(channel, { verification_message_id: null }, gs, ctx.guildId);
        await cfgAudit(ctx, 'verification_setup', { roleId: role.id, channelId: channel.id });
        return ctx.reply({ embeds: [embed.success('Verification Ready', `Role: <@&${role.id}>\nChannel: <#${channel.id}>\n\nNothing else was changed. To hide the rest of the server from unverified members run \`verification lockdown\` (it asks for confirmation). Existing members are **not** auto-verified.`)] });
      },
    },
    enable: { description: 'Enable verification', async execute(ctx) {
      const s = await ctx.deps.guildSettings.get(ctx.guildId);
      if (!s.verification_role_id || !s.verification_channel_id) return ctx.reply(err('Not Configured', 'Run `verification setup` first.'));
      await ctx.deps.guildSettings.update(ctx.guildId, { verification_enabled: 1 });
      await cfgAudit(ctx, 'verification_enabled');
      return ctx.reply({ embeds: [embed.success('Verification Enabled', 'The Verify button works again.')] });
    } },
    disable: { description: 'Disable verification (does not change channel permissions)', async execute(ctx) {
      const s = await ctx.deps.guildSettings.get(ctx.guildId);
      await ctx.deps.guildSettings.update(ctx.guildId, { verification_enabled: 0 });
      await cfgAudit(ctx, 'verification_disabled');
      const locked = !!parseLockdown(s.verification_lockdown);
      return ctx.reply({ embeds: [embed.warn('Verification Disabled', `The Verify button no longer grants the role. Channel permissions were **not** changed, so nothing becomes visible by accident and no one is auto-verified.${locked ? '\n\n🔒 A lockdown is still active: new members will see nothing until you run `verification unlock` (restores the previous visibility).' : ''}`)] });
    } },
    lockdown: { description: 'Hide public channels from @everyone; verified role can see them', async execute(ctx) {
      const s = await ctx.deps.guildSettings.get(ctx.guildId);
      if (!s.verification_enabled || !s.verification_role_id || !s.verification_channel_id) return ctx.reply(err('Not Ready', 'Run `verification setup` first.'));
      if (parseLockdown(s.verification_lockdown)) return ctx.reply(err('Already Locked', 'A lockdown is already active. Run `verification unlock` first to redo it.'));
      const { guild } = ctx;
      const everyone = guild.roles.everyone;
      const verified = await guild.roles.fetch(s.verification_role_id).catch(() => null);
      if (!verified) return ctx.reply(err('Role Missing', 'The verified role was deleted. Run `verification setup` again.'));
      const chans = [...(await guild.channels.fetch()).values()].filter(Boolean);
      const plan = planLockdown({
        channels: chans.map((c) => ({ id: c.id, everyoneCanView: !!c.permissionsFor(everyone)?.has('ViewChannel'), everyoneOverwrite: overwriteState(c, everyone.id), verifiedOverwrite: overwriteState(c, verified.id) })),
        exemptChannelIds: [s.verification_channel_id, s.honeypot_enabled ? s.honeypot_channel_id : null],
      });
      return confirm(ctx, {
        title: 'Verification Lockdown',
        text: `This will change permissions on **${plan.ops.length}** channel(s): @everyone loses *View Channel*, <@&${verified.id}> gains it. **${plan.skipped.filter((x) => x.reason === 'ALREADY_PRIVATE').length}** private channel(s) are left untouched. Unverified members, including everyone currently in the server, will lose access until verified.`,
        fn: async () => {
          const done = [];
          for (const op of plan.ops) {
            const c = await guild.channels.fetch(op.channelId).catch(() => null);
            if (!c) continue;
            try {
              await c.permissionOverwrites.edit(everyone, { ViewChannel: false }, { reason: 'Verification lockdown' });
              await c.permissionOverwrites.edit(verified, { ViewChannel: true }, { reason: 'Verification lockdown' });
              done.push(op);
            } catch { /* skipped channel: reported below */ }
          }
          await ctx.deps.guildSettings.update(ctx.guildId, { verification_lockdown: serializeLockdown({ ops: done }) });
          await cfgAudit(ctx, 'verification_lockdown', { changed: done.length, planned: plan.ops.length });
          return `Locked **${done.length}/${plan.ops.length}** channel(s).${done.length < plan.ops.length ? ' Some channels could not be changed (missing Manage Channels there).' : ''} Grant the verified role to current members you want to keep.`;
        },
      });
    } },
    unlock: { description: 'Undo the lockdown (restores previous permissions)', async execute(ctx) {
      const s = await ctx.deps.guildSettings.get(ctx.guildId);
      const snap = parseLockdown(s.verification_lockdown);
      if (!snap) return ctx.reply(err('No Lockdown', 'There is no recorded lockdown to undo.'));
      return confirm(ctx, {
        title: 'Undo Lockdown',
        text: `Restores the previous @everyone / verified-role visibility on **${snap.ops.length}** channel(s). Channels that were public before become public again.`,
        fn: async () => {
          const everyone = ctx.guild.roles.everyone;
          const verified = s.verification_role_id ? await ctx.guild.roles.fetch(s.verification_role_id).catch(() => null) : null;
          let restored = 0;
          for (const op of snap.ops) {
            const c = await ctx.guild.channels.fetch(op.channelId).catch(() => null);
            if (!c) continue;
            try {
              await c.permissionOverwrites.edit(everyone, { ViewChannel: stateToValue(op.priorEveryone) }, { reason: 'Verification unlock' });
              if (verified) await c.permissionOverwrites.edit(verified, { ViewChannel: stateToValue(op.priorVerified) }, { reason: 'Verification unlock' });
              restored += 1;
            } catch { /* continue */ }
          }
          await ctx.deps.guildSettings.update(ctx.guildId, { verification_lockdown: null });
          await cfgAudit(ctx, 'verification_unlock', { restored });
          return `Restored **${restored}/${snap.ops.length}** channel(s).`;
        },
      });
    } },
    status: { description: 'Show verification status and detect problems', async execute(ctx) {
      const s = await ctx.deps.guildSettings.get(ctx.guildId);
      const role = s.verification_role_id ? await ctx.guild.roles.fetch(s.verification_role_id).catch(() => null) : null;
      const ch = s.verification_channel_id ? await ctx.guild.channels.fetch(s.verification_channel_id).catch(() => null) : null;
      const problems = [];
      if (s.verification_enabled && !role) problems.push('verified role is missing');
      if (s.verification_enabled && !ch) problems.push('verification channel is missing');
      if (role && role.position >= ctx.guild.members.me.roles.highest.position) problems.push('verified role is above my highest role');
      if (!ctx.guild.members.me.permissions.has('ManageRoles')) problems.push('I lack Manage Roles');
      return ctx.reply(eph(embed.info('Verification Status', [`State: ${onOff(s.verification_enabled)}`, `Role: ${role ? `<@&${role.id}>` : '_none_'}`, `Channel: ${ch ? `<#${ch.id}>` : '_none_'}`, `Lockdown: ${parseLockdown(s.verification_lockdown) ? '🔒 active' : 'off'}`, problems.length ? `⚠️ **Problems:** ${problems.join('; ')} → run \`verification repair\`` : '✅ No problems detected'].join('\n'))));
    } },
    repair: { description: 'Re-post the verify panel / re-check dependencies', async execute(ctx) {
      const s = await ctx.deps.guildSettings.get(ctx.guildId);
      const ch = s.verification_channel_id ? await ctx.guild.channels.fetch(s.verification_channel_id).catch(() => null) : null;
      const role = s.verification_role_id ? await ctx.guild.roles.fetch(s.verification_role_id).catch(() => null) : null;
      if (!role || !ch) return ctx.reply(err('Cannot Repair', `${!role ? 'The verified role' : 'The verification channel'} no longer exists. Run \`verification setup\` to choose or create a new one.`));
      await postVerifyMessage(ch, s, ctx.deps.guildSettings, ctx.guildId);
      await cfgAudit(ctx, 'verification_repair');
      return ctx.reply({ embeds: [embed.success('Repaired', 'The verify panel is present and the role and channel exist.')] });
    } },
  },
});
const onOff = (v) => (v ? '🟢 enabled' : '⚪ disabled');

module.exports = { commands: [verification], VERIFY_ID, verifyMessage };
