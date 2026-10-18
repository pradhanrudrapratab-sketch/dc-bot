'use strict';
const { defineCommand } = require('../../framework/command');
const { embed } = require('../../utils/embeds');
const { err } = require('../_util');

const balance = defineCommand({
  name: 'balance', aliases: ['bal'], description: 'Show your DarkEssence (DE) balance', category: 'economy', cooldownMs: 3000,
  options: [{ name: 'user', type: 'user', description: 'Another user (defaults to you)' }],
  async execute(ctx) {
    const id = ctx.options.user || ctx.user.id;
    const bal = await ctx.deps.economy.balance(id);
    return ctx.reply({ embeds: [embed.info('DarkEssence', `<@${id}> has **${bal.toLocaleString('en-US')} DE**`)], allowedMentions: { parse: [] } });
  },
});

// Operator tooling only. Earning/spending mechanics are intentionally not invented here (see docs/COMMANDS.md).
const deadmin = defineCommand({
  name: 'deadmin', description: '[Owner] Grant or take DarkEssence', category: 'owner', ownerOnly: true, prefix: false, guildOnly: false,
  subcommands: {
    grant: { description: 'Grant DE', options: [{ name: 'user', type: 'user', description: 'User', required: true }, { name: 'amount', type: 'integer', description: 'Amount', required: true, min: 1 }], async execute(ctx) {
      const r = await ctx.deps.economy.credit(ctx.options.user, ctx.options.amount, `owner grant by ${ctx.user.id}`);
      return ctx.reply(r.ok ? { embeds: [embed.success('Granted', `New balance: **${r.balance} DE**`)], ephemeral: true } : err('Failed', r.reason));
    } },
    take: { description: 'Take DE', options: [{ name: 'user', type: 'user', description: 'User', required: true }, { name: 'amount', type: 'integer', description: 'Amount', required: true, min: 1 }], async execute(ctx) {
      const r = await ctx.deps.economy.debit(ctx.options.user, ctx.options.amount, `owner take by ${ctx.user.id}`);
      return ctx.reply(r.ok ? { embeds: [embed.success('Taken', `New balance: **${r.balance} DE**`)], ephemeral: true } : err('Failed', r.reason));
    } },
  },
});

module.exports = { commands: [balance, deadmin] };
