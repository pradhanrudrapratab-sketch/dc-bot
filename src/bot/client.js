'use strict';
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');
const logger = require('../utils/logger');

/**
 * Privileged intents that must be enabled in the Developer Portal: SERVER MEMBERS and MESSAGE CONTENT.
 * (Presence intent is NOT needed.)
 */
const INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers, // privileged: join/leave, invite tracking, role-change logs
  GatewayIntentBits.GuildModeration, // ban events + audit-log entry stream
  GatewayIntentBits.GuildInvites,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildWebhooks,
  GatewayIntentBits.MessageContent, // privileged: prefix commands, OwO payment text, message logs
];

function createClient() {
  return new Client({
    intents: INTENTS,
    partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
    allowedMentions: { parse: [], repliedUser: false },
  });
}

/** Register every event module in ./events. A module exports one event or `{ events: [...] }`. */
function registerEvents(client, container) {
  const dir = path.join(__dirname, 'events');
  let n = 0;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const mod = require(path.join(dir, file));
    for (const ev of mod.events ?? [mod]) {
      const handler = async (...args) => {
        try { await ev.execute(container, ...args); } catch (err) { logger.error(`[EVENT] ${ev.name} handler failed`, { error: err, file }); }
      };
      if (ev.once) client.once(ev.name, handler); else client.on(ev.name, handler);
      n += 1;
    }
  }
  logger.info(`[BOT] registered ${n} event handler(s)`);
}

module.exports = { createClient, registerEvents, INTENTS };
