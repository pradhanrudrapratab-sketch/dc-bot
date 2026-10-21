'use strict';
const { Events, ActivityType } = require('discord.js');
const logger = require('../../utils/logger');

module.exports = [
  {
    name: Events.ClientReady, once: true,
    async execute(c, client) {
      logger.info(`[BOT] Logged in as ${client.user.tag}; serving ${client.guilds.cache.size} guild(s)`);
      client.user.setActivity('Minecraft AFK | /status', { type: ActivityType.Watching });
      for (const row of await c.guildSettings.listWhere('invite_tracking_enabled')) {
        const g = client.guilds.cache.get(row.guild_id);
        if (g) await c.inviteTracker.refresh(g);
      }
    },
  },
  {
    name: Events.GuildCreate,
    async execute(c, guild) {
      const s = await c.guildSettings.get(guild.id);
      if (s.invite_tracking_enabled) await c.inviteTracker.refresh(guild);
    },
  },
];
module.exports = { events: module.exports };
