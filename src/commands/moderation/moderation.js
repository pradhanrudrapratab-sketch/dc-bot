'use strict';
const { defineCommand } = require('../../framework/command');
const { embed } = require('../../utils/embeds');
const { eventId } = require('../_util');

const userOpt = { name: 'user', type: 'user', description: 'Target user', required: true };
const reasonOpt = { name: 'reason', type: 'string', description: 'Reason (recorded in the audit log)', required: true, rest: true, maxLength: 400 };
const base = { category: 'moderation', guildOnly: true };

const show = (ctx, r) => ctx.reply({ embeds: [(r.ok ? embed.success : embed.error)(r.ok ? 'Done' : 'Action Failed', r.message)], ephemeral: !r.ok });

const ban = defineCommand({
  ...base, name: 'ban', description: 'Ban a member (or a user by ID)', userPermissions: ['BanMembers'], botPermissions: ['BanMembers'],
  options: [userOpt, reasonOpt, { name: 'delete_days', type: 'integer', description: 'Days of messages to delete (0-7)', min: 0, max: 7, slashOnly: true }],
  async execute(ctx) {
    const r = await ctx.deps.moderation.ban({ guild: ctx.guild, actorMember: ctx.member, targetId: ctx.options.user, reason: ctx.options.reason, deleteSeconds: (ctx.options.delete_days || 0) * 86400 });
    return show(ctx, r);
  },
});

const unban = defineCommand({
  ...base, name: 'unban', description: 'Unban a user by ID', userPermissions: ['BanMembers'], botPermissions: ['BanMembers'],
  options: [{ name: 'user_id', type: 'user', description: 'ID of the banned user', required: true }, reasonOpt],
  async execute(ctx) {
    return show(ctx, await ctx.deps.moderation.unban({ guild: ctx.guild, actorMember: ctx.member, targetId: ctx.options.user_id, reason: ctx.options.reason }));
  },
});

// Slash: /kick   Prefix: !modkick  (the playful action command is never called "kick": see docs)
const kick = defineCommand({
  ...base, name: 'kick', prefixNames: ['modkick'], description: 'Kick a member from the server', userPermissions: ['KickMembers'], botPermissions: ['KickMembers'],
  options: [userOpt, reasonOpt],
  async execute(ctx) {
    return show(ctx, await ctx.deps.moderation.kick({ guild: ctx.guild, actorMember: ctx.member, targetId: ctx.options.user, reason: ctx.options.reason }));
  },
});

const mute = defineCommand({
  ...base, name: 'mute', description: 'Timeout a member (e.g. 10m, 2h, 1d)', userPermissions: ['ModerateMembers'], botPermissions: ['ModerateMembers'],
  options: [userOpt, { name: 'duration', type: 'duration', description: 'Duration such as 10m, 2h, 1d (max 28d)', required: true }, { name: 'reason', type: 'string', description: 'Reason', rest: true, maxLength: 400 }],
  async execute(ctx) {
    return show(ctx, await ctx.deps.moderation.timeout({ guild: ctx.guild, actorMember: ctx.member, targetId: ctx.options.user, durationMs: ctx.options.duration, reason: ctx.options.reason || 'No reason provided' }));
  },
});

const unmute = defineCommand({
  ...base, name: 'unmute', description: "Remove a member's timeout", userPermissions: ['ModerateMembers'], botPermissions: ['ModerateMembers'],
  options: [userOpt, { name: 'reason', type: 'string', description: 'Reason', rest: true, maxLength: 400 }],
  async execute(ctx) {
    return show(ctx, await ctx.deps.moderation.untimeout({ guild: ctx.guild, actorMember: ctx.member, targetId: ctx.options.user, reason: ctx.options.reason || 'No reason provided' }));
  },
});

const warn = defineCommand({
  ...base, name: 'warn', description: 'Warn a member (3rd = 24h timeout, 4th = kick, 5th = ban)', userPermissions: ['ModerateMembers'],
  options: [userOpt, reasonOpt],
  async execute(ctx) {
    const r = await ctx.deps.moderation.warn({ guild: ctx.guild, actorMember: ctx.member, targetId: ctx.options.user, reason: ctx.options.reason, idempotencyKey: `warn:${eventId(ctx)}` });
    if (!r.ok) return show(ctx, r);
    if (r.duplicate) return ctx.reply({ embeds: [embed.info('Already Recorded', r.message)], ephemeral: true });
    const lines = [`<@${ctx.options.user}> now has **${r.activeCount}** active warning(s).`];
    if (r.resetApplied) lines.push('_Their earlier warnings had expired (30 days without a new warning), so the active count restarted._');
    if (r.escalation) lines.push(r.escalation.ok ? `⚖️ Automatic action **${r.escalation.action}** applied.` : `⚠️ Automatic action **${r.escalation.action}** FAILED: ${r.escalation.message}\nStaff have been alerted; handle this manually.`);
    return ctx.reply({ embeds: [(r.escalation && !r.escalation.ok ? embed.warn : embed.success)('Warning Recorded', lines.join('\n'))] });
  },
});

const warnings = defineCommand({
  ...base, name: 'warnings', description: "Show a member's warning history", userPermissions: ['ModerateMembers'],
  options: [userOpt],
  async execute(ctx) {
    const w = ctx.deps.warnings;
    const id = ctx.options.user;
    const st = await w.getState(ctx.guildId, id);
    const hist = await w.history(ctx.guildId, id, 8);
    const lines = hist.map((h) => `**#${h.id}** <t:${Math.floor(h.created_at / 1000)}:d> by <@${h.moderator_id}> — ${h.reason.slice(0, 80)}${h.escalation_action ? ` → ${h.escalation_action} ${h.escalation_status === 'SUCCESS' ? '✅' : h.escalation_status === 'FAILED' ? '❌' : '⏳'}` : ''}`);
    return ctx.reply({ embeds: [embed.info('Warnings', [`<@${id}>: **${st.activeCount}** active · **${st.total}** total ever`, st.lastWarningAt ? `Last warning: <t:${Math.floor(st.lastWarningAt / 1000)}:R>` : '', '', ...(lines.length ? lines : ['_No warnings on record._'])].join('\n'))], ephemeral: true });
  },
});

const warnreset = defineCommand({
  ...base, name: 'warnreset', description: "Reset a member's ACTIVE warning count (history is kept)", userPermissions: ['Administrator'],
  options: [userOpt, { name: 'reason', type: 'string', description: 'Reason', rest: true, maxLength: 400 }],
  async execute(ctx) {
    const prev = await ctx.deps.warnings.manualReset(ctx.guildId, ctx.options.user);
    await ctx.deps.audit.record({ guildId: ctx.guildId, category: 'moderation', action: 'warnings_reset', actorId: ctx.user.id, targetId: ctx.options.user, details: { previousActive: prev, reason: ctx.options.reason || null } });
    return ctx.reply({ embeds: [embed.success('Active Warnings Reset', `<@${ctx.options.user}> went from **${prev}** to **0** active warnings. Warning history is preserved.`)] });
  },
});

const purge = defineCommand({
  ...base, name: 'purge', description: 'Bulk-delete recent messages (1-100)', userPermissions: ['ManageMessages'],
  options: [{ name: 'count', type: 'integer', description: 'How many messages (1-100)', required: true, min: 1, max: 100 }, { name: 'user', type: 'user', description: 'Only delete this user\'s messages' }],
  async execute(ctx) {
    if (ctx.message) await ctx.message.delete().catch(() => {}); // remove the invoking message first
    const r = await ctx.deps.moderation.purge({ guild: ctx.guild, channel: ctx.channel, actorMember: ctx.member, count: ctx.options.count, targetUserId: ctx.options.user || null });
    const e = (r.ok ? embed.success : embed.error)(r.ok ? 'Purged' : 'Purge Failed', r.message);
    if (ctx.source === 'prefix') { const m = await ctx.channel.send({ embeds: [e] }); setTimeout(() => m.delete().catch(() => {}), 5000); return undefined; }
    return ctx.reply({ embeds: [e], ephemeral: true });
  },
});

module.exports = { commands: [ban, unban, kick, mute, unmute, warn, warnings, warnreset, purge] };
