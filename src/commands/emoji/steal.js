'use strict';
const { defineCommand } = require('../../framework/command');
const { embed } = require('../../utils/embeds');
const { parseEmoji, cdnUrl, planDestination, MAX_BYTES } = require('../../services/emoji');
const { classifyDiscordError } = require('../../services/permissions');
const { err } = require('../_util');

const ICON = { SUCCESS: '✅', ALREADY_EXISTS: '🟰', NO_CAPACITY: '📦', PERMISSION_MISSING: '🔒', SKIPPED_NOT_ADMIN: '🚫', INACCESSIBLE_SOURCE: '❓', FAILED: '❌' };

async function download(http, emoji) {
  const res = await http.get(cdnUrl(emoji), { responseType: 'arraybuffer', timeout: 8000, maxContentLength: MAX_BYTES, maxRedirects: 0, validateStatus: (s) => s === 200 });
  const buf = Buffer.from(res.data);
  if (!buf.length || buf.length > MAX_BYTES) throw new Error('size');
  return buf;
}

const steal = defineCommand({
  name: 'steal', description: 'Copy a custom emoji to every server where you are an Administrator', category: 'emoji', cooldownMs: 10_000,
  options: [
    { name: 'emoji', type: 'string', description: 'The custom emoji (paste it) or its ID', required: true, maxLength: 100 },
    { name: 'name', type: 'string', description: 'Optional new name', maxLength: 32 },
  ],
  async execute(ctx) {
    await ctx.defer({ ephemeral: true });
    const emoji = parseEmoji(ctx.options.emoji, ctx.options.name);
    if (!emoji) return ctx.reply(err('Not an Emoji', 'Paste a **custom** emoji such as `<:name:123456789012345678>` (standard emoji cannot be stolen).'));

    let buffer;
    try { buffer = await download(ctx.deps.http, emoji); } catch {
      return ctx.reply(err('Source Inaccessible', 'I could not download that emoji (deleted, wrong ID, or too large).'));
    }

    const results = [];
    for (const guild of ctx.client.guilds.cache.values()) {
      // Eligibility is verified through the API: never assumed from cache.
      const member = await guild.members.fetch(ctx.user.id).catch(() => null);
      if (!member) continue; // user is not in this guild
      const emojis = await guild.emojis.fetch().catch(() => null);
      if (!emojis) { results.push({ guild, status: 'PERMISSION_MISSING' }); continue; }
      const list = [...emojis.values()];
      const plan = planDestination(emoji, {
        userIsAdmin: member.permissions.has('Administrator'),
        botHasPerm: guild.members.me.permissions.has('ManageGuildExpressions'),
        tier: guild.premiumTier ?? 0,
        existingNames: new Set(list.map((e) => e.name.toLowerCase())),
        staticCount: list.filter((e) => !e.animated).length,
        animatedCount: list.filter((e) => e.animated).length,
      });
      if (plan.status !== 'READY') { results.push({ guild, status: plan.status }); continue; }
      try {
        await guild.emojis.create({ attachment: buffer, name: emoji.name, reason: `Emoji stolen by ${ctx.user.tag ?? ctx.user.id}` });
        results.push({ guild, status: 'SUCCESS' });
      } catch (e) {
        const kind = classifyDiscordError(e);
        results.push({ guild, status: kind === 'LIMIT_REACHED' ? 'NO_CAPACITY' : kind === 'PERMISSION_OR_HIERARCHY' ? 'PERMISSION_MISSING' : 'FAILED', detail: kind });
      }
    }

    await ctx.deps.audit.record({ guildId: ctx.guildId, category: 'emoji', action: 'emoji_steal', actorId: ctx.user.id, details: { emojiId: emoji.id, name: emoji.name, results: results.map((r) => ({ guild: r.guild.id, status: r.status })) } });
    const ok = results.filter((r) => r.status === 'SUCCESS').length;
    const lines = results.map((r) => `${ICON[r.status] || '❔'} **${r.guild.name}** — ${r.status.replace(/_/g, ' ').toLowerCase()}`);
    return ctx.reply({ embeds: [(ok ? embed.success : embed.warn)(`Emoji :${emoji.name}: — ${ok}/${results.length} added`, lines.join('\n').slice(0, 3900) || '_No shared servers where you are an Administrator and I am present._')], ephemeral: true });
  },
});

module.exports = { commands: [steal] };
