'use strict';

const BOT_PERMISSIONS = [
  'ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory', 'ManageMessages', 'ManageChannels', 'ManageRoles',
  'ManageGuild', 'KickMembers', 'BanMembers', 'ModerateMembers', 'ViewAuditLog', 'ManageGuildExpressions',
];

/** Real OAuth2 bot-invite URL (no redirect/callback involved). */
function buildInviteUrl(clientId, PermissionFlagsBits) {
  const bits = BOT_PERMISSIONS.reduce((acc, p) => acc | PermissionFlagsBits[p], 0n);
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot%20applications.commands&permissions=${bits}`;
}

module.exports = { buildInviteUrl, BOT_PERMISSIONS };
