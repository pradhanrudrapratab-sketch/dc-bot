'use strict';
const { defineCommand } = require('../../framework/command');
const { embed } = require('../../utils/embeds');
const { FUN_ACTIONS, validateTemplate, validateMediaUrl } = require('../../services/fun');
const { eph, err, cfgAudit } = require('../_util');

/** One independent command per action (never shares a handler with moderation). */
const actionCommands = Object.entries(FUN_ACTIONS).map(([action, def]) => defineCommand({
  name: action, description: `${def.verb[0].toUpperCase()}${def.verb.slice(1)} someone (configurable message + GIF)`, category: 'fun', cooldownMs: 5000,
  options: [{ name: 'target', type: 'user', description: 'Who to target (defaults to yourself)' }],
  async execute(ctx) {
    const targetId = ctx.options.target || ctx.user.id;
    const r = await ctx.deps.fun.compose({ guildId: ctx.guildId, guildName: ctx.guild.name, action, actorMention: `<@${ctx.user.id}>`, targetMention: `<@${targetId}>` });
    if (!r.enabled) return ctx.reply(err('Disabled', `\`${action}\` is disabled on this server.`));
    const e = embed.brand(null, r.text);
    if (r.imageUrl) e.setImage(r.imageUrl);
    return ctx.reply({ embeds: [e], allowedMentions: { parse: [] } });
  },
}));

const actionChoices = Object.keys(FUN_ACTIONS);
const actionOpt = { name: 'action', type: 'string', description: 'Fun action', required: true, choices: actionChoices };

async function mutate(ctx, scope, fields, auditAction) {
  await ctx.deps.fun.upsert(scope, ctx.options.action, fields, ctx.user.id);
  await cfgAudit(ctx, auditAction, { action: ctx.options.action, scope: scope === '*' ? 'global' : 'guild' });
}
const scopeOf = (ctx) => (ctx.options.global ? '*' : ctx.guildId);
const globalOpt = { name: 'global', type: 'boolean', description: 'Change the global default (bot owner only)' };
const guardGlobal = (ctx) => (ctx.options.global && !ctx.deps.config.bot.superAdmins.has(ctx.user.id) ? ctx.reply(err('Owner Only', 'Only the bot owner can change global defaults.')) : null);

const funset = defineCommand({
  name: 'funset', description: 'Configure fun action messages and media', category: 'fun', userPermissions: ['Administrator'],
  subcommands: {
    message: {
      description: 'Set the message ({actor} {target} {guild})', options: [actionOpt, { name: 'text', type: 'string', description: 'Template, e.g. {actor} slaps {target}!', required: true, rest: true, maxLength: 300 }, { ...globalOpt, slashOnly: true }],
      async execute(ctx) {
        const denied = guardGlobal(ctx); if (denied) return denied;
        const v = validateTemplate(ctx.options.text);
        if (!v.ok) return ctx.reply(err('Invalid Message', v.error));
        await mutate(ctx, scopeOf(ctx), { message_template: v.value }, 'fun_message');
        return ctx.reply({ embeds: [embed.success('Message Updated', `\`${ctx.options.action}\`: ${v.value}`)] });
      },
    },
    media: {
      description: 'Set a direct https GIF/image URL', options: [actionOpt, { name: 'url', type: 'string', description: 'https URL to a GIF or image', required: true, maxLength: 500 }, { ...globalOpt, slashOnly: true }],
      async execute(ctx) {
        const denied = guardGlobal(ctx); if (denied) return denied;
        const v = validateMediaUrl(ctx.options.url);
        if (!v.ok) return ctx.reply(err('Invalid Media URL', v.error));
        await mutate(ctx, scopeOf(ctx), { media_url: v.value, source: 'direct' }, 'fun_media');
        return ctx.reply({ embeds: [embed.success('Media Updated', `\`${ctx.options.action}\` will show ${v.value}`)] });
      },
    },
    source: {
      description: 'Choose direct URL or the GIF provider', options: [actionOpt, { name: 'mode', type: 'string', description: 'direct or provider', required: true, choices: ['direct', 'provider'] }, { name: 'query', type: 'string', description: 'Provider search term', maxLength: 50 }, { ...globalOpt, slashOnly: true }],
      async execute(ctx) {
        const denied = guardGlobal(ctx); if (denied) return denied;
        if (ctx.options.mode === 'provider' && !ctx.deps.funProviderAvailable) return ctx.reply(err('No Provider', 'No GIF provider is configured on this bot (`GIF_PROVIDER` / `GIF_API_KEY`).'));
        await mutate(ctx, scopeOf(ctx), { source: ctx.options.mode, ...(ctx.options.query ? { provider_query: ctx.options.query } : {}) }, 'fun_source');
        return ctx.reply({ embeds: [embed.success('Source Updated', `\`${ctx.options.action}\` now uses **${ctx.options.mode}**.`)] });
      },
    },
    preview: {
      description: 'Preview an action as it would appear', options: [actionOpt],
      async execute(ctx) {
        const r = await ctx.deps.fun.compose({ guildId: ctx.guildId, guildName: ctx.guild.name, action: ctx.options.action, actorMention: `<@${ctx.user.id}>`, targetMention: `<@${ctx.user.id}>` });
        const e = embed.brand('Preview', r.text);
        if (r.imageUrl) e.setImage(r.imageUrl);
        return ctx.reply({ embeds: [e, ...(r.degraded ? [embed.warn('Media Unavailable', 'The configured media/provider failed; the text-only fallback is used.')] : [])], allowedMentions: { parse: [] }, ephemeral: true });
      },
    },
    reset: {
      description: 'Reset an action to its default', options: [actionOpt, { ...globalOpt, slashOnly: true }],
      async execute(ctx) {
        const denied = guardGlobal(ctx); if (denied) return denied;
        const had = await ctx.deps.fun.reset(scopeOf(ctx), ctx.options.action);
        await cfgAudit(ctx, 'fun_reset', { action: ctx.options.action });
        return ctx.reply({ embeds: [embed.success('Reset', had ? `\`${ctx.options.action}\` is back to the default.` : 'It was already default.')] });
      },
    },
    list: {
      description: 'List fun actions',
      async execute(ctx) {
        const lines = [];
        for (const a of actionChoices) { const c = await ctx.deps.fun.effective(ctx.guildId, a); lines.push(`**${a}** — ${c.template}${c.mediaUrl || c.source === 'provider' ? ' 🖼️' : ''}${c.enabled ? '' : ' (disabled)'}`); }
        return ctx.reply(eph(embed.info('Fun Actions', lines.join('\n'))));
      },
    },
  },
});

module.exports = { commands: [...actionCommands, funset] };
