'use strict';
const { embed } = require('../utils/embeds');
const logger = require('../utils/logger');
const { label } = require('./permissionNames');

const fmtMissing = (list) => list.map((p) => `**${label(p)}**`).join(', ');

async function deny(ctx, title, description) {
  return ctx.reply({ embeds: [embed.error(title, description)], ephemeral: true });
}

/**
 * Shared execution pipeline for slash AND prefix invocations:
 * guild-only -> owner-only -> user permissions -> bot permissions -> cooldown -> execute (error-safe).
 * @param {object} command  defineCommand result
 * @param {object} ctx      framework context
 * @param {{config:object, cooldowns:object, permissionMonitor?:object}} env
 */
async function runCommand(command, ctx, env) {
  const sub = ctx.subcommand ? command.subcommands?.[ctx.subcommand] : null;
  const target = sub || command;
  const label_ = ctx.subcommand ? `${command.name} ${ctx.subcommand}` : command.name;

  try {
    if (command.guildOnly && !ctx.guild) return await deny(ctx, 'Server Only', 'This command can only be used inside a server.');

    if (command.ownerOnly || sub?.ownerOnly) {
      if (!env.config.bot.superAdmins.has(ctx.user.id)) return await deny(ctx, 'Owner Only', 'This command is restricted to the bot owner.');
    }

    const userPerms = [...new Set([...(command.userPermissions || []), ...(sub?.userPermissions || [])])];
    if (userPerms.length) {
      const missing = userPerms.filter((p) => !ctx.memberPermissions?.has(p));
      if (missing.length) return await deny(ctx, 'Missing Permissions', `You need ${fmtMissing(missing)} to use this command.`);
    }

    const botPerms = [...new Set([...(command.botPermissions || []), ...(sub?.botPermissions || [])])];
    if (botPerms.length && ctx.guild) {
      const me = ctx.guild.members?.me;
      const missing = botPerms.filter((p) => !me?.permissions?.has(p));
      await env.permissionMonitor?.report(ctx.guild.id, `cmd:${label_}`, missing).catch(() => {});
      if (missing.length) {
        return await deny(ctx, 'Bot Missing Permissions', `I need ${fmtMissing(missing)} for this command. Only this feature is affected; everything else keeps working.`);
      }
    }

    const cd = target.cooldownMs ?? command.cooldownMs;
    const remaining = env.cooldowns.consume(label_, ctx.user.id, cd);
    if (remaining > 0) return await deny(ctx, 'Slow Down', `Try again in ${(remaining / 1000).toFixed(1)}s.`);

    await (sub || command).execute(ctx);
    return undefined;
  } catch (err) {
    logger.error(`[CMD] ${label_} failed`, { error: err, guildId: ctx.guildId, userId: ctx.user?.id });
    try {
      await ctx.reply({ embeds: [embed.error('Something Went Wrong', 'The command failed unexpectedly. The error has been logged.')], ephemeral: true });
    } catch (replyErr) {
      logger.warn(`[CMD] could not deliver error reply for ${label_}`, { error: replyErr });
    }
    return undefined;
  }
}

module.exports = { runCommand };
