'use strict';
const { embed } = require('../utils/embeds');

const eph = (e) => ({ embeds: [e], ephemeral: true });
const ok = (title, text, extra = {}) => ({ embeds: [embed.success(title, text)], ...extra });
const err = (title, text, extra = { ephemeral: true }) => ({ embeds: [embed.error(title, text)], ...extra });
const isTrusted = (ctx) => ctx.user.id === ctx.guild?.ownerId || ctx.deps.config.bot.superAdmins.has(ctx.user.id);
const eventId = (ctx) => ctx.interaction?.id ?? ctx.message?.id ?? `${ctx.user.id}:${Date.now()}`;

/** Resolve a channel option to a text channel in this guild, defaulting to the invoking channel. */
async function textChannel(ctx, optionName = 'channel') {
  const id = ctx.options[optionName];
  const ch = id ? await ctx.guild.channels.fetch(id).catch(() => null) : ctx.channel;
  return ch && ch.isTextBased?.() && !ch.isThread?.() && ch.guildId === ctx.guild.id ? ch : null;
}

const cfgAudit = (ctx, action, details = null, extra = {}) =>
  ctx.deps.audit.record({ guildId: ctx.guildId, category: 'config', action, actorId: ctx.user.id, details, ...extra });

/** Check bot permissions in a specific channel; returns the missing permission names. */
const missingIn = (channel, guild, perms) => perms.filter((p) => !channel.permissionsFor(guild.members.me)?.has(p));

module.exports = { eph, ok, err, isTrusted, eventId, textChannel, cfgAudit, missingIn };
