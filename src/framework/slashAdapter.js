'use strict';

const GUILD_CONTEXT = 0; // InteractionContextType.Guild

function addOption(builder, o) {
  const apply = (x) => {
    x.setName(o.name).setDescription(o.description).setRequired(!!o.required);
    return x;
  };
  switch (o.type) {
    case 'user': return builder.addUserOption(apply);
    case 'channel': return builder.addChannelOption(apply);
    case 'role': return builder.addRoleOption(apply);
    case 'boolean': return builder.addBooleanOption(apply);
    case 'integer':
      return builder.addIntegerOption((x) => {
        apply(x);
        if (o.min !== undefined) x.setMinValue(o.min);
        if (o.max !== undefined) x.setMaxValue(o.max);
        return x;
      });
    case 'number': return builder.addNumberOption(apply);
    case 'duration':
    case 'string':
    default:
      return builder.addStringOption((x) => {
        apply(x);
        if (o.maxLength) x.setMaxLength(o.maxLength);
        if (o.minLength) x.setMinLength(o.minLength);
        if (o.choices) x.addChoices(...o.choices.map((c) => (typeof c === 'string' ? { name: c, value: c } : c)));
        return x;
      });
  }
}

/**
 * Build slash-command JSON for a command definition.
 * @param {object} command            result of defineCommand
 * @param {Function} SlashCommandBuilder discord.js class (injected so this stays testable)
 * @param {object} PermissionFlagsBits   discord.js permission bits
 */
function buildSlash(command, SlashCommandBuilder, PermissionFlagsBits) {
  const b = new SlashCommandBuilder().setName(command.name).setDescription(command.description);
  if (command.subcommands) {
    for (const [name, sub] of Object.entries(command.subcommands)) {
      b.addSubcommand((s) => {
        s.setName(name).setDescription(sub.description);
        for (const o of sub.options) addOption(s, o);
        return s;
      });
    }
  } else {
    for (const o of command.options) addOption(b, o);
  }
  if (command.userPermissions.length) {
    b.setDefaultMemberPermissions(command.userPermissions.reduce((acc, p) => acc | PermissionFlagsBits[p], 0n));
  }
  if (command.guildOnly) {
    if (typeof b.setContexts === 'function') b.setContexts(GUILD_CONTEXT);
    else if (typeof b.setDMPermission === 'function') b.setDMPermission(false);
  }
  return b;
}

/** Build the framework context for a chat-input interaction. */
function slashContext(interaction, deps, respond) {
  const sub = command_hasSub(interaction);
  const options = {};
  const data = interaction.options?.data || [];
  const flat = sub ? (data[0]?.options || []) : data;
  for (const o of flat) {
    // user/channel/role options are normalised to IDs; everything else uses the raw value
    options[o.name] = o.type === 6 || o.type === 7 || o.type === 8 ? String(o.value) : o.value;
  }
  return {
    source: 'slash',
    interaction,
    client: interaction.client,
    guild: interaction.guild,
    guildId: interaction.guildId,
    channel: interaction.channel,
    user: interaction.user,
    member: interaction.member,
    memberPermissions: interaction.memberPermissions,
    subcommand: sub || null,
    options,
    deps,
    reply: (payload) => respond(interaction, payload),
    defer: async ({ ephemeral = false } = {}) => {
      if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: ephemeral ? 64 : undefined });
    },
  };
}

function command_hasSub(interaction) {
  try { return interaction.options?.getSubcommand?.(false) || null; } catch { return null; }
}

module.exports = { buildSlash, slashContext, addOption };
