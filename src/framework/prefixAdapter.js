'use strict';
const { parseArgs, usage } = require('./optionParser');

/**
 * Parse a message into { command, subcommand, options } or an error.
 * @param {string} content raw message text
 * @param {string} prefix  guild prefix
 * @param {Map<string,object>} index name/alias -> command
 * @returns {null | {error:string, usage?:string} | {command:object, subcommand:string|null, options:object}}
 */
function parsePrefixMessage(content, prefix, index) {
  if (!content || !content.startsWith(prefix)) return null;
  const body = content.slice(prefix.length);
  const m = body.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const command = index.get(m[1].toLowerCase());
  if (!command) return null;
  let rest = m[2] || '';
  let sub = null;
  let optionSpecs = command.options.filter((o) => !o.slashOnly);
  let label = command.name;
  if (command.subcommands) {
    const sm = rest.match(/^(\S+)(?:\s+([\s\S]*))?$/);
    const subName = sm?.[1]?.toLowerCase();
    if (!subName || !command.subcommands[subName]) {
      const names = Object.keys(command.subcommands).join(' | ');
      return { error: `Usage: \`${prefix}${command.name} <${names}>\`` };
    }
    sub = subName;
    rest = sm[2] || '';
    optionSpecs = command.subcommands[subName].options.filter((o) => !o.slashOnly);
    label = `${command.name} ${subName}`;
  }
  const parsed = parseArgs(optionSpecs, rest);
  if (!parsed.ok) return { error: `${parsed.error}\nUsage: \`${usage(prefix, label, optionSpecs)}\`` };
  return { command, subcommand: sub, options: parsed.values };
}

function prefixContext(message, parsed, deps) {
  const noPing = { parse: [], repliedUser: false };
  return {
    source: 'prefix',
    message,
    client: message.client,
    guild: message.guild,
    guildId: message.guildId,
    channel: message.channel,
    user: message.author,
    member: message.member,
    memberPermissions: message.member?.permissions,
    subcommand: parsed.subcommand,
    options: parsed.options,
    deps,
    reply: async (payload) => {
      const { flags, ephemeral, ...rest } = payload || {};
      return message.reply({ ...rest, allowedMentions: noPing });
    },
    defer: async () => { try { await message.channel.sendTyping(); } catch { /* ignore */ } },
  };
}

module.exports = { parsePrefixMessage, prefixContext };
