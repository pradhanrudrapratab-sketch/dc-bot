'use strict';
// Subset of discord.js PermissionFlagsBits keys this bot uses. Validated at command-definition time.
const PERMISSION_NAMES = new Set([
  'Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'ManageMessages', 'KickMembers',
  'BanMembers', 'ModerateMembers', 'ViewAuditLog', 'ManageGuildExpressions', 'SendMessages', 'EmbedLinks',
  'ViewChannel', 'ReadMessageHistory', 'AttachFiles', 'ManageWebhooks', 'CreateInstantInvite',
]);

const PERMISSION_LABELS = {
  ManageGuild: 'Manage Server', ManageGuildExpressions: 'Manage Expressions', ViewAuditLog: 'View Audit Log',
  KickMembers: 'Kick Members', BanMembers: 'Ban Members', ModerateMembers: 'Timeout Members',
  ManageRoles: 'Manage Roles', ManageChannels: 'Manage Channels', ManageMessages: 'Manage Messages',
  SendMessages: 'Send Messages', EmbedLinks: 'Embed Links', ViewChannel: 'View Channel',
  ReadMessageHistory: 'Read Message History', AttachFiles: 'Attach Files', ManageWebhooks: 'Manage Webhooks',
  CreateInstantInvite: 'Create Invite', Administrator: 'Administrator',
};

const label = (name) => PERMISSION_LABELS[name] || name;

module.exports = { PERMISSION_NAMES, label };
