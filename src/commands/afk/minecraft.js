'use strict';
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { defineCommand } = require('../../framework/command');
const { checkMinecraftAccess } = require('../../services/afkAccess');
const { parsePing } = require('../../services/afkApi');
const { validateServerAddress, validatePort, validateMinecraftName } = require('../../services/validators');
const { embed } = require('../../utils/embeds');

const ADMIN = ['Administrator'];

/** The two button rows used by /status (kept identical to the original panel). */
function statusRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('mc_start').setLabel('▶ Start').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('mc_stop').setLabel('⏹ Stop').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('mc_ping').setLabel('📡 Ping').setStyle(ButtonStyle.Primary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('mc_jump').setLabel('🦘 Auto-Jump').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('mc_move').setLabel('🚶 Auto-Move').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('mc_sneak').setLabel('🥷 Auto-Sneak').setStyle(ButtonStyle.Secondary)
    ),
  ];
}

const pingEmbed = (data, slotNumber) => {
  const p = parsePing(data);
  const line = p.online ? '🟢 **Server Online**' : '🔴 **Server Offline**';
  const players = p.online ? `\n👥 **Players:** ${p.current ?? '?'}/${p.max ?? '?'}` : '';
  return embed.info('📡 Server Status', `${line}${players}\n\n**Slot:** #${slotNumber}`);
};

/** Factory for the simple "call an endpoint, report the result" commands. */
function action({ name, description, endpoint, options = [], params = () => ({}), validate = () => null, title, text }) {
  return defineCommand({
    name, description, category: 'afk', prefix: false, userPermissions: ADMIN, options,
    async execute(ctx) {
      await ctx.defer();
      const { db, subs, slots, afkApi } = ctx.deps;
      const access = await checkMinecraftAccess({ db, subs, slots }, { guildId: ctx.guildId, isAdmin: ctx.memberPermissions?.has('Administrator') });
      if (!access.ok) return ctx.reply({ embeds: [embed.error(access.title, access.description)], ephemeral: true });
      const bad = validate(ctx.options);
      if (bad) return ctx.reply({ embeds: [embed.error('Invalid Value', bad)], ephemeral: true });
      const result = await afkApi.callSlot(access.slot.url, endpoint, params(ctx.options));
      if (!result.ok) return ctx.reply({ embeds: [embed.error('API Request Failed', result.error)] });
      return ctx.reply({ embeds: [embed.success(title, `${text(ctx.options)}\n\n**Slot:** #${access.slot.slot_number}`)], components: [] });
    },
  });
}

const toggles = [['jump', '🦘 Auto-Jump Toggled', 'Auto-jump has been toggled.'], ['move', '🚶 Auto-Move Toggled', 'Auto-move has been toggled.'], ['sneak', '🥷 Auto-Sneak Toggled', 'Auto-sneak has been toggled.']]
  .map(([n, title, t]) => action({ name: n, description: `Toggle auto-${n} on the AFK bot`, endpoint: n, title, text: () => t }));

const commands = [
  action({ name: 'start', description: 'Start the Minecraft AFK bot', endpoint: 'start', title: '🟢 Minecraft Bot Started', text: () => 'The AFK bot is now **running**.' }),
  action({ name: 'stop', description: 'Stop the Minecraft AFK bot', endpoint: 'stop', title: '⏹ Minecraft Bot Stopped', text: () => 'The AFK bot has been **stopped**.' }),
  action({
    name: 'ip', description: 'Set the Minecraft server IP', endpoint: 'ip', title: '🌐 Server IP Updated',
    options: [{ name: 'address', type: 'string', description: 'Server IP address or hostname', required: true, maxLength: 253 }],
    validate: (o) => { const v = validateServerAddress(o.address); return v.ok ? null : v.error; },
    params: (o) => ({ value: o.address.trim() }), text: (o) => `Server IP set to \`${o.address.trim()}\``,
  }),
  action({
    name: 'port', description: 'Set the Minecraft server port', endpoint: 'port', title: '🔌 Server Port Updated',
    options: [{ name: 'port', type: 'integer', description: 'Port number (default: 25565)', required: true, min: 1, max: 65535 }],
    validate: (o) => { const v = validatePort(o.port); return v.ok ? null : v.error; },
    params: (o) => ({ value: o.port }), text: (o) => `Server port set to \`${o.port}\``,
  }),
  action({
    name: 'rename', description: "Rename the AFK bot's Minecraft username", endpoint: 'rename', title: '✏️ Bot Renamed',
    options: [{ name: 'username', type: 'string', description: 'New bot username', required: true, maxLength: 16 }],
    validate: (o) => { const v = validateMinecraftName(o.username); return v.ok ? null : v.error; },
    params: (o) => ({ value: o.username.trim() }), text: (o) => `Bot username changed to \`${o.username.trim()}\``,
  }),
  ...toggles,
  defineCommand({
    name: 'ping', description: 'Check the Minecraft server status', category: 'afk', prefix: false, userPermissions: ADMIN,
    async execute(ctx) {
      await ctx.defer();
      const { db, subs, slots, afkApi } = ctx.deps;
      const access = await checkMinecraftAccess({ db, subs, slots }, { guildId: ctx.guildId, isAdmin: ctx.memberPermissions?.has('Administrator') });
      if (!access.ok) return ctx.reply({ embeds: [embed.error(access.title, access.description)], ephemeral: true });
      const r = await afkApi.callSlot(access.slot.url, 'ping');
      if (!r.ok) return ctx.reply({ embeds: [embed.error('Ping Failed', r.error)] });
      return ctx.reply({ embeds: [pingEmbed(r.data, access.slot.slot_number)], components: statusRows() });
    },
  }),
  defineCommand({
    name: 'status', description: 'Show current slot status with quick-action buttons', category: 'afk', prefix: false, userPermissions: ADMIN,
    async execute(ctx) {
      await ctx.defer();
      const { db, subs, slots } = ctx.deps;
      const access = await checkMinecraftAccess({ db, subs, slots }, { guildId: ctx.guildId, isAdmin: ctx.memberPermissions?.has('Administrator') });
      if (!access.ok) return ctx.reply({ embeds: [embed.error(access.title, access.description)], ephemeral: true });
      const { slot, assignment } = access;
      const sub = await subs.getActive(db, assignment.user_id);
      return ctx.reply({
        embeds: [embed.info('📊 Bot Status', [
          `**Slot:** #${slot.slot_number}`,
          `**Status:** ${slot.status === 'ASSIGNED' ? '🟢 Assigned' : `🔴 ${slot.status}`}`,
          `**Health:** ${slot.health === 'UNHEALTHY' ? '🔴 Unhealthy' : slot.health === 'HEALTHY' ? '🟢 Healthy' : '⚪ Unknown'}`,
          `**Server:** ${assignment.server_name || ctx.guild?.name || 'This Server'}`,
          sub ? `**Subscription ends:** <t:${Math.floor(sub.expires_at / 1000)}:R>` : null,
          '', '_Use the buttons below to control the AFK bot._',
        ].filter((x) => x !== null).join('\n'))],
        components: statusRows(),
      });
    },
  }),
];

module.exports = { commands, statusRows, pingEmbed };
