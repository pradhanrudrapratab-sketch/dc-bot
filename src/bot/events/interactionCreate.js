'use strict';
const { Events } = require('discord.js');
const { respond } = require('../respond');
const { slashContext } = require('../../framework/slashAdapter');
const { runCommand } = require('../../framework/runner');
const { parseConfirmId } = require('../../services/confirmations');
const { checkMinecraftAccess } = require('../../services/afkAccess');
const { pingEmbed } = require('../../commands/afk/minecraft');
const { canGrantRole } = require('../../services/verification');
const { classifyDiscordError } = require('../../services/permissions');
const { embed } = require('../../utils/embeds');
const logger = require('../../utils/logger');

const MC_BUTTONS = {
  mc_start: { endpoint: 'start', title: '🟢 Bot Started', text: 'The AFK bot is now **running**.' },
  mc_stop: { endpoint: 'stop', title: '⏹ Bot Stopped', text: 'The AFK bot has been **stopped**.' },
  mc_jump: { endpoint: 'jump', title: '🦘 Auto-Jump Toggled', text: 'Auto-jump has been toggled.' },
  mc_move: { endpoint: 'move', title: '🚶 Auto-Move Toggled', text: 'Auto-move has been toggled.' },
  mc_sneak: { endpoint: 'sneak', title: '🥷 Auto-Sneak Toggled', text: 'Auto-sneak has been toggled.' },
  mc_ping: { endpoint: 'ping' },
};

const eph = (e) => ({ embeds: [e], flags: 64 });

async function minecraftButton(c, interaction) {
  const spec = MC_BUTTONS[interaction.customId];
  // Acknowledge first, then report with followUp (the panel message stays intact). Never reply() after defer.
  await interaction.deferUpdate();
  const access = await checkMinecraftAccess(c, { guildId: interaction.guildId, isAdmin: !!interaction.memberPermissions?.has('Administrator') });
  if (!access.ok) return interaction.followUp(eph(embed.error(access.title, access.description)));
  const wait = c.cooldowns.consume('mc_button', interaction.user.id, 2000);
  if (wait > 0) return interaction.followUp(eph(embed.warn('Slow Down', `Try again in ${(wait / 1000).toFixed(1)}s.`)));
  const result = await c.afkApi.callSlot(access.slot.url, spec.endpoint);
  if (!result.ok) return interaction.followUp(eph(embed.error('API Request Failed', result.error)));
  logger.info(`[AFK] button ${interaction.customId}`, { guildId: interaction.guildId, userId: interaction.user.id });
  if (spec.endpoint === 'ping') return interaction.followUp(eph(pingEmbed(result.data, access.slot.slot_number)));
  return interaction.followUp(eph(embed.success(spec.title, `${spec.text}\n\n**Slot:** #${access.slot.slot_number}`)));
}

async function confirmButton(c, interaction) {
  const parsed = parseConfirmId(interaction.customId);
  const t = c.confirmations.take(parsed.id, { userId: interaction.user.id, guildId: interaction.guildId });
  if (!t.ok) {
    const msg = { UNKNOWN: 'This confirmation is no longer valid.', EXPIRED: 'This confirmation expired. Run the command again.', NOT_OWNER: 'This confirmation belongs to someone else.', WRONG_GUILD: 'This confirmation belongs to another server.' }[t.reason];
    return respond(interaction, { embeds: [embed.error('Cannot Confirm', msg)], ephemeral: true });
  }
  if (!parsed.accepted) return interaction.update({ embeds: [embed.info('Cancelled', 'No changes were made.')], components: [] });
  return t.entry.run(interaction);
}

async function verifyButton(c, interaction) {
  if (!interaction.guild) return undefined;
  const settings = await c.guildSettings.get(interaction.guildId);
  const role = settings.verification_role_id ? await interaction.guild.roles.fetch(settings.verification_role_id).catch(() => null) : null;
  const me = interaction.guild.members.me;
  const d = canGrantRole({ settings, role, botTop: me.roles.highest.position, botHasManageRoles: me.permissions.has('ManageRoles'), alreadyHas: !!interaction.member.roles.cache?.has(settings.verification_role_id) });
  await c.permissionMonitor.report(interaction.guildId, 'verification', d.code === 'NO_PERMISSION' || d.code === 'HIERARCHY' ? [d.code === 'NO_PERMISSION' ? 'ManageRoles' : 'RoleHierarchy'] : []).catch(() => {});
  if (!d.ok) return respond(interaction, { embeds: [(d.code === 'ALREADY' ? embed.info : embed.error)(d.code === 'ALREADY' ? 'Already Verified' : 'Cannot Verify', d.message)], ephemeral: true });
  try {
    await interaction.member.roles.add(role.id, 'Verification button');
  } catch (err) {
    const kind = classifyDiscordError(err);
    logger.warn('[VERIFY] role add failed', { error: err, guildId: interaction.guildId, kind });
    return respond(interaction, { embeds: [embed.error('Verification Failed', 'I could not give you the role (permission or role-position problem). An administrator has been notified.')], ephemeral: true });
  }
  await c.audit.record({ guildId: interaction.guildId, category: 'member', action: 'member_verified', actorId: interaction.user.id, targetId: interaction.user.id });
  return respond(interaction, { embeds: [embed.success('Verified', 'Welcome! You now have access to the server.')], ephemeral: true });
}

module.exports = {
  name: Events.InteractionCreate,
  async execute(c, interaction) {
    try {
      if (interaction.isChatInputCommand()) {
        const command = c.registry.slash.get(interaction.commandName);
        if (!command) return await respond(interaction, { embeds: [embed.error('Unknown Command', 'This command is not registered. It may need a redeploy.')], ephemeral: true });
        return await runCommand(command, slashContext(interaction, c.deps, respond), c.runEnv);
      }
      if (interaction.isButton()) {
        const id = interaction.customId;
        if (id.startsWith('cf:')) return await confirmButton(c, interaction);
        if (id === 'verify:grant') return await verifyButton(c, interaction);
        if (MC_BUTTONS[id]) return await minecraftButton(c, interaction);
      }
    } catch (err) {
      logger.error('[INTERACTION] handler failed', { error: err, id: interaction.customId ?? interaction.commandName });
      try { await respond(interaction, { embeds: [embed.error('Something Went Wrong', 'The action failed unexpectedly. The error has been logged.')], ephemeral: true }); } catch { /* interaction already dead */ }
    }
    return undefined;
  },
};
