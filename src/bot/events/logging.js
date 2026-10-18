'use strict';
const { Events } = require('discord.js');
const { embed } = require('../../utils/embeds');
const { snapshotChannel, snapshotRole } = require('../../services/antinuke');

const clip = (s, n = 900) => (s && s.length > n ? `${s.slice(0, n)}…` : s || '_(empty)_');
const send = (c, guildId, category, e) => c.logs.send(guildId, category, { embeds: [e] });
const on = (c, guildId, category) => c.logs.isEnabled(guildId, category);

module.exports = { events: [
  {
    name: Events.MessageDelete,
    async execute(c, m) {
      if (!m.guildId || !(await on(c, m.guildId, 'message'))) return;
      const snap = c.messageCache.take(m.id);
      const author = m.author ?? (snap?.authorId ? { id: snap.authorId } : null);
      if (author?.bot) return;
      await send(c, m.guildId, 'message', embed.warn('Message Deleted', `${author ? `Author: <@${author.id}>\n` : 'Author: unknown\n'}Channel: <#${m.channelId}>\n${snap || m.content ? `Content: ${clip(snap?.content ?? m.content)}` : '_Content unavailable (message was sent before I saw it)._'}${snap?.attachments?.length ? `\nAttachments: ${snap.attachments.map((a) => a.name).join(', ')}` : ''}`));
    },
  },
  {
    name: Events.MessageUpdate,
    async execute(c, before, after) {
      if (!after.guildId || after.author?.bot || !(await on(c, after.guildId, 'message'))) return;
      const prev = c.messageCache.update(after);
      const oldText = before.content ?? prev?.content;
      if (oldText === after.content) return; // embed/pin updates
      await send(c, after.guildId, 'message', embed.info('Message Edited', `Author: <@${after.author?.id}>\nChannel: <#${after.channelId}> · [jump](${after.url})\n**Before:** ${oldText != null ? clip(oldText, 700) : '_unavailable_'}\n**After:** ${clip(after.content, 700)}`));
    },
  },
  {
    name: Events.VoiceStateUpdate,
    async execute(c, before, after) {
      const g = after.guild;
      if (before.channelId === after.channelId || !(await on(c, g.id, 'voice'))) return;
      const what = !before.channelId ? `joined <#${after.channelId}>` : !after.channelId ? `left <#${before.channelId}>` : `moved <#${before.channelId}> → <#${after.channelId}>`;
      await send(c, g.id, 'voice', embed.info('Voice Activity', `<@${after.id}> ${what}`));
    },
  },
  {
    name: Events.ChannelCreate,
    async execute(c, ch) { if (ch.guild && await on(c, ch.guild.id, 'channel')) await send(c, ch.guild.id, 'channel', embed.success('Channel Created', `<#${ch.id}> (${ch.name})`)); },
  },
  {
    name: Events.ChannelDelete,
    async execute(c, ch) {
      if (!ch.guild) return;
      c.antiNuke.rememberDeleted('channel', ch); // snapshot for best-effort restore
      if (await on(c, ch.guild.id, 'channel')) await send(c, ch.guild.id, 'channel', embed.warn('Channel Deleted', `**${ch.name}** (\`${ch.id}\`)\n_Snapshot kept briefly for anti-nuke restore: ${JSON.stringify(snapshotChannel(ch)).length} bytes._`));
    },
  },
  {
    name: Events.ChannelUpdate,
    async execute(c, before, after) {
      if (!after.guild || !(await on(c, after.guild.id, 'channel'))) return;
      const diffs = [];
      if (before.name !== after.name) diffs.push(`name: ${before.name} → ${after.name}`);
      if (before.topic !== after.topic) diffs.push('topic changed');
      if (before.nsfw !== after.nsfw) diffs.push(`nsfw: ${before.nsfw} → ${after.nsfw}`);
      if (before.permissionOverwrites?.cache?.size !== after.permissionOverwrites?.cache?.size) diffs.push('permission overwrites changed');
      if (diffs.length) await send(c, after.guild.id, 'channel', embed.info('Channel Updated', `<#${after.id}>\n${diffs.join('\n')}`));
    },
  },
  {
    name: Events.GuildRoleCreate,
    async execute(c, r) { if (await on(c, r.guild.id, 'role')) await send(c, r.guild.id, 'role', embed.success('Role Created', `<@&${r.id}> (${r.name})`)); },
  },
  {
    name: Events.GuildRoleDelete,
    async execute(c, r) {
      c.antiNuke.rememberDeleted('role', r);
      if (await on(c, r.guild.id, 'role')) await send(c, r.guild.id, 'role', embed.warn('Role Deleted', `**${r.name}** (\`${r.id}\`) — ${JSON.stringify(snapshotRole(r)).length} byte snapshot held`));
    },
  },
  {
    name: Events.GuildRoleUpdate,
    async execute(c, before, after) {
      if (!(await on(c, after.guild.id, 'role'))) return;
      const diffs = [];
      if (before.name !== after.name) diffs.push(`name: ${before.name} → ${after.name}`);
      if (before.permissions.bitfield !== after.permissions.bitfield) diffs.push('permissions changed');
      if (before.color !== after.color) diffs.push('color changed');
      if (diffs.length) await send(c, after.guild.id, 'role', embed.info('Role Updated', `<@&${after.id}>\n${diffs.join('\n')}`));
    },
  },
  {
    name: Events.WebhooksUpdate,
    async execute(c, channel) { if (channel.guild && await on(c, channel.guild.id, 'security')) await send(c, channel.guild.id, 'security', embed.warn('Webhooks Changed', `Webhooks were created, edited or deleted in <#${channel.id}>.`)); },
  },
  {
    name: Events.GuildBanAdd,
    async execute(c, ban) { if (await on(c, ban.guild.id, 'moderation')) await send(c, ban.guild.id, 'moderation', embed.warn('Member Banned', `<@${ban.user.id}> (\`${ban.user.id}\`)${ban.reason ? `\nReason: ${clip(ban.reason, 300)}` : ''}`)); },
  },
  {
    name: Events.GuildBanRemove,
    async execute(c, ban) { if (await on(c, ban.guild.id, 'moderation')) await send(c, ban.guild.id, 'moderation', embed.info('Member Unbanned', `<@${ban.user.id}> (\`${ban.user.id}\`)`)); },
  },
] };
