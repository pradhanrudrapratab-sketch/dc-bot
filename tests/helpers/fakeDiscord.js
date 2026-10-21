'use strict';
/**
 * Minimal stand-in for discord.js so modules can be loaded and unit-tested where the real package is not
 * installed. It enforces the Discord command-schema rules that commonly break deploys (name format,
 * description length, option ordering/limits). It is NOT a substitute for `npm run deploy-commands`
 * against the real library; see docs/TESTING.md.
 */
const Module = require('node:module');
const path = require('node:path');

const NAME = /^[\p{Ll}\p{Lo}\p{N}_-]{1,32}$/u;
const names = ['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'ManageMessages', 'KickMembers', 'BanMembers',
  'ModerateMembers', 'ViewAuditLog', 'ManageGuildExpressions', 'SendMessages', 'EmbedLinks', 'ViewChannel', 'ReadMessageHistory',
  'AttachFiles', 'ManageWebhooks', 'CreateInstantInvite'];
const PermissionFlagsBits = Object.fromEntries(names.map((n, i) => [n, 1n << BigInt(i)]));

class EmbedBuilder {
  constructor() { this.data = { fields: [] }; }
  setColor(c) { this.data.color = c; return this; }
  setTitle(t) { this.data.title = t; return this; }
  setDescription(d) { this.data.description = d; return this; }
  setFooter(f) { this.data.footer = f; return this; }
  setTimestamp(t) { this.data.timestamp = t; return this; }
  setImage(u) { this.data.image = { url: u }; return this; }
  setThumbnail(u) { this.data.thumbnail = { url: u }; return this; }
  addFields(...f) { this.data.fields.push(...f.flat()); return this; }
  toJSON() { return this.data; }
  static from(e) { const b = new EmbedBuilder(); b.data = { ...(e.data || e) }; return b; }
}

class Opt {
  constructor(type) { this.type = type; this.d = { type }; }
  setName(n) { if (!NAME.test(n)) throw new Error(`Invalid option/command name: ${n}`); this.d.name = n; return this; }
  setDescription(s) { if (!s || s.length > 100) throw new Error(`Invalid description: ${s}`); this.d.description = s; return this; }
  setRequired(r) { this.d.required = !!r; return this; }
  setMinValue(v) { this.d.min = v; return this; }
  setMaxValue(v) { this.d.max = v; return this; }
  setMaxLength(v) { this.d.maxLength = v; return this; }
  setMinLength(v) { this.d.minLength = v; return this; }
  addChoices(...c) { this.d.choices = c; return this; }
}

function checkOptions(list) {
  if (list.length > 25) throw new Error('More than 25 options');
  let optional = false;
  const seen = new Set();
  for (const o of list) {
    if (seen.has(o.name)) throw new Error(`Duplicate option ${o.name}`);
    seen.add(o.name);
    if (o.required && optional) throw new Error(`Required option ${o.name} after optional`);
    if (!o.required) optional = true;
  }
}

class Builder {
  constructor() { this.d = { options: [] }; }
  setName(n) { if (!NAME.test(n)) throw new Error(`Invalid name: ${n}`); this.d.name = n; return this; }
  setDescription(s) { if (!s || s.length > 100) throw new Error(`Invalid description: ${s}`); this.d.description = s; return this; }
  setDefaultMemberPermissions(p) { this.d.default_member_permissions = String(p); return this; }
  setContexts(c) { this.d.contexts = [c]; return this; }
  _add(type, fn) { const o = new Opt(type); fn(o); this.d.options.push({ ...o.d }); checkOptions(this.d.options); return this; }
  addStringOption(fn) { return this._add(3, fn); }
  addIntegerOption(fn) { return this._add(4, fn); }
  addBooleanOption(fn) { return this._add(5, fn); }
  addUserOption(fn) { return this._add(6, fn); }
  addChannelOption(fn) { return this._add(7, fn); }
  addRoleOption(fn) { return this._add(8, fn); }
  addNumberOption(fn) { return this._add(10, fn); }
  toJSON() { return this.d; }
}
class SlashCommandSubcommandBuilder extends Builder {}
class SlashCommandBuilder extends Builder {
  addSubcommand(fn) {
    if (this.d.options.some((o) => o.type !== 1)) throw new Error('Cannot mix subcommands and options');
    const s = new SlashCommandSubcommandBuilder();
    fn(s);
    if (this.d.options.length >= 25) throw new Error('More than 25 subcommands');
    this.d.options.push({ type: 1, ...s.d });
    return this;
  }
  _add(type, fn) {
    if (this.d.options.some((o) => o.type === 1)) throw new Error('Cannot mix subcommands and options');
    return super._add(type, fn);
  }
}

class Chainable { constructor() { this.d = {}; } }
class ButtonBuilder extends Chainable {
  setCustomId(i) { this.d.custom_id = i; return this; }
  setLabel(l) { this.d.label = l; return this; }
  setStyle(s) { this.d.style = s; return this; }
  setDisabled(x = true) { this.d.disabled = x; return this; }
  toJSON() { return this.d; }
}
class ActionRowBuilder extends Chainable {
  constructor() { super(); this.components = []; }
  addComponents(...c) { this.components.push(...c.flat()); return this; }
}

const fake = {
  EmbedBuilder, SlashCommandBuilder, ButtonBuilder, ActionRowBuilder, PermissionFlagsBits,
  ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 },
  ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4, GuildAnnouncement: 5 },
  GatewayIntentBits: new Proxy({}, { get: (_, k) => String(k) }),
  Partials: { Message: 'Message', Channel: 'Channel', GuildMember: 'GuildMember' },
  Events: new Proxy({}, { get: (_, k) => String(k) }),
  AuditLogEvent: { ChannelDelete: 12, RoleDelete: 32, MemberKick: 20, MemberBanAdd: 22, BotAdd: 28, WebhookCreate: 50, GuildUpdate: 1 },
  OverwriteType: { Role: 0, Member: 1 },
  MessageFlags: { Ephemeral: 64 },
  Client: class {}, Collection: Map, REST: class {}, Routes: {},
};

const real = Module._resolveFilename;
const stubPath = path.join(__dirname, '__discord_stub__.js');
Module._resolveFilename = function (request, ...rest) {
  if (request === 'discord.js') return stubPath;
  return real.call(this, request, ...rest);
};
// axios / node-cron are only needed to *construct* the container; stub them for offline tests.
const axiosStub = path.join(__dirname, '__axios_stub__.js');
require.cache[axiosStub] = { id: axiosStub, filename: axiosStub, loaded: true, children: [], paths: [], exports: { create: () => ({ get: async () => { throw new Error('network disabled in tests'); } }), get: async () => { throw new Error('network disabled in tests'); } } };
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'axios') return axiosStub;
  return realResolve.call(this, request, ...rest);
};
require.cache[stubPath] = { id: stubPath, filename: stubPath, loaded: true, exports: fake, children: [], paths: [] };

module.exports = fake;
