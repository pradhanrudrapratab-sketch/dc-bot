'use strict';
const { defineCommand } = require('../../framework/command');
const { embed } = require('../../utils/embeds');
const { formatDuration } = require('../../utils/time');
const { err } = require('../_util');

const fmt = (n) => Number(n).toLocaleString('en-US');
const noPing = { parse: [] };

const balance = defineCommand({
  name: 'balance', aliases: ['bal'], description: 'Show your DarkEssence (DE) balance', category: 'economy', cooldownMs: 3000,
  options: [{ name: 'user', type: 'user', description: 'Another user (defaults to you)' }],
  async execute(ctx) {
    const id = ctx.options.user || ctx.user.id;
    const bal = await ctx.deps.economy.balance(id);
    return ctx.reply({ embeds: [embed.info('💰 DarkEssence', `<@${id}> has **${fmt(bal)} DE**`)], allowedMentions: noPing });
  },
});

const daily = defineCommand({
  name: 'daily', description: 'Claim your daily DarkEssence reward', category: 'economy',
  async execute(ctx) {
    const r = await ctx.deps.economy.daily(ctx.user.id);
    if (!r.ok) {
      return ctx.reply({ embeds: [embed.warn('Already Claimed', `Your next daily is ready <t:${Math.floor(r.retryAt / 1000)}:R> (<t:${Math.floor(r.retryAt / 1000)}:t>).`)], ephemeral: true });
    }
    const bonus = r.amount - ctx.deps.economy.settings.dailyAmount;
    return ctx.reply({ embeds: [embed.success('Daily Reward', [`You received **${fmt(r.amount)} DE**${bonus ? ` (+${bonus} streak bonus)` : ''}.`, `🔥 Streak: **${r.streak}** day(s). Claim every day (within 48h) to grow it.`, `💰 Balance: **${fmt(r.balance)} DE**`].join('\n'))] });
  },
});

const COIN = { heads: '🪙 Heads', tails: '🪙 Tails' };
const coinflip = defineCommand({
  name: 'coinflip', aliases: ['cf', 'flip'], description: 'Bet DarkEssence on a coin flip', category: 'economy', cooldownMs: 5000,
  options: [
    { name: 'bet', type: 'integer', description: 'How much DE to bet', required: true, min: 1 },
    { name: 'side', type: 'string', description: 'heads or tails (default heads)', choices: ['heads', 'tails'] },
  ],
  async execute(ctx) {
    const side = ctx.options.side || 'heads';
    const eco = ctx.deps.economy;
    const r = await eco.coinflip(ctx.user.id, ctx.options.bet, side);
    if (!r.ok) {
      const msg = {
        INSUFFICIENT_FUNDS: `You only have **${fmt(r.balance ?? 0)} DE**. Try \`daily\` for free DE.`,
        OVER_MAX_BET: `The maximum bet is **${fmt(r.max)} DE**.`,
        BAD_AMOUNT: 'Bet must be a whole number above 0.', BAD_SIDE: 'Pick heads or tails.',
      }[r.reason] || 'The flip could not be completed.';
      return ctx.reply(err('Cannot Flip', msg));
    }
    const e = (r.won ? embed.success : embed.error)(r.won ? 'You Won!' : 'You Lost', [
      `You picked **${side}**. It landed on **${COIN[r.result]}**.`,
      r.won ? `+**${fmt(r.delta)} DE**` : `−**${fmt(-r.delta)} DE**`,
      `💰 Balance: **${fmt(r.balance)} DE**`,
    ].join('\n'));
    if (eco.settings.showFlipCounter) e.setFooter({ text: `Flip ${r.inCycle}/${r.every} · the last flip of every ${r.every} is a loss` });
    return ctx.reply({ embeds: [e] });
  },
});

const give = defineCommand({
  name: 'give', aliases: ['pay'], description: 'Give some of your DarkEssence to another user', category: 'economy', cooldownMs: 5000,
  options: [{ name: 'user', type: 'user', description: 'Who gets it', required: true }, { name: 'amount', type: 'integer', description: 'Amount of DE', required: true, min: 1 }],
  async execute(ctx) {
    const r = await ctx.deps.economy.transfer(ctx.user.id, ctx.options.user, ctx.options.amount);
    if (!r.ok) {
      const msg = { INSUFFICIENT_FUNDS: 'You do not have that much DE.', SAME_ACCOUNT: 'You cannot give DE to yourself.', BAD_AMOUNT: 'Amount must be a whole number above 0.' }[r.reason] || 'Transfer failed.';
      return ctx.reply(err('Transfer Failed', msg));
    }
    return ctx.reply({ embeds: [embed.success('Sent', `You gave **${fmt(ctx.options.amount)} DE** to <@${ctx.options.user}>.\n💰 Your balance: **${fmt(r.balance)} DE**`)], allowedMentions: noPing });
  },
});

const richest = defineCommand({
  name: 'richest', aliases: ['lb', 'top'], description: 'Top DarkEssence balances', category: 'economy', cooldownMs: 5000,
  async execute(ctx) {
    const rows = await ctx.deps.economy.leaderboard(10);
    const text = rows.length ? rows.map((r, i) => `**${i + 1}.** <@${r.user_id}> — ${fmt(r.balance)} DE`).join('\n') : '_Nobody has any DE yet. Use `daily`!_';
    return ctx.reply({ embeds: [embed.info('🏆 Richest Players', text)], allowedMentions: noPing });
  },
});

// Operator tooling only.
const deadmin = defineCommand({
  name: 'deadmin', description: '[Owner] Grant or take DarkEssence', category: 'owner', ownerOnly: true, prefix: false, guildOnly: false,
  subcommands: {
    grant: { description: 'Grant DE', options: [{ name: 'user', type: 'user', description: 'User', required: true }, { name: 'amount', type: 'integer', description: 'Amount', required: true, min: 1 }], async execute(ctx) {
      const r = await ctx.deps.economy.credit(ctx.options.user, ctx.options.amount, `owner grant by ${ctx.user.id}`);
      return ctx.reply(r.ok ? { embeds: [embed.success('Granted', `New balance: **${fmt(r.balance)} DE**`)], ephemeral: true } : err('Failed', r.reason));
    } },
    take: { description: 'Take DE', options: [{ name: 'user', type: 'user', description: 'User', required: true }, { name: 'amount', type: 'integer', description: 'Amount', required: true, min: 1 }], async execute(ctx) {
      const r = await ctx.deps.economy.debit(ctx.options.user, ctx.options.amount, `owner take by ${ctx.user.id}`);
      return ctx.reply(r.ok ? { embeds: [embed.success('Taken', `New balance: **${fmt(r.balance)} DE**`)], ephemeral: true } : err('Failed', r.reason));
    } },
  },
});

module.exports = { commands: [balance, daily, coinflip, give, richest, deadmin] };
