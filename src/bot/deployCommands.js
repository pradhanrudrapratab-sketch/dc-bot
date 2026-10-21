'use strict';
/**
 * Registers slash commands with Discord. Needs only DISCORD_TOKEN and CLIENT_ID.
 *   npm run deploy-commands             -> global (can take up to ~1h to appear)
 *   DEV_GUILD_ID=<id> npm run deploy-commands -> one guild, instant (for testing)
 * Fails loudly if any definition is invalid (the real discord.js builders validate them).
 */
require('dotenv').config();
const path = require('node:path');
const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { loadCommands } = require('../framework/registry');
const { buildSlash } = require('../framework/slashAdapter');

async function main() {
  const { DISCORD_TOKEN, CLIENT_ID, DEV_GUILD_ID } = process.env;
  if (!DISCORD_TOKEN || !CLIENT_ID) throw new Error('DISCORD_TOKEN and CLIENT_ID are required');
  const registry = loadCommands(path.join(__dirname, '../commands'));
  const body = [...registry.slash.values()].map((c) => buildSlash(c, SlashCommandBuilder, PermissionFlagsBits).toJSON());
  const names = new Set();
  for (const b of body) { if (names.has(b.name)) throw new Error(`duplicate ${b.name}`); names.add(b.name); }
  console.log(`[DEPLOY] ${body.length} slash command(s): ${[...names].join(', ')}`);
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const route = DEV_GUILD_ID ? Routes.applicationGuildCommands(CLIENT_ID, DEV_GUILD_ID) : Routes.applicationCommands(CLIENT_ID);
  await rest.put(route, { body });
  console.log(`[DEPLOY] done (${DEV_GUILD_ID ? `guild ${DEV_GUILD_ID}` : 'global'})`);
}

if (require.main === module) main().catch((e) => { console.error('[DEPLOY] failed:', e.message); process.exit(1); });
module.exports = { main };
