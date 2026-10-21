'use strict';
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { defineCommand } = require('../../framework/command');
const { assertSafeHttpUrl } = require('../../services/urlGuard');
const { embed } = require('../../utils/embeds');
const logger = require('../../utils/logger');

const owner = { category: 'owner', prefix: false, ownerOnly: true, guildOnly: false };
const eph = (e) => ({ embeds: [e], ephemeral: true });
const slotOpt = { name: 'slot', type: 'integer', description: 'Slot number', required: true, min: 1 };
const audit = (ctx, a) => ctx.deps.audit.record({ guildId: ctx.guildId ?? null, category: 'config', actorId: ctx.user.id, ...a });

async function safeUrl(ctx, raw) {
  try { return { ok: true, url: await assertSafeHttpUrl(raw, { allowPrivate: ctx.deps.config.afk.allowPrivateSlotUrls }) }; } catch (e) { return { ok: false, error: e.message }; }
}

const setkey = defineCommand({
  ...owner, name: 'setkey', description: '[Owner] Set the global API key for all slots',
  options: [{ name: 'key', type: 'string', description: 'The new API key', required: true, maxLength: 200 }],
  async execute(ctx) {
    await ctx.defer({ ephemeral: true });
    if (!ctx.deps.settings.canStoreSecrets) {
      return ctx.reply(eph(embed.error('Cannot Store Key', 'No `SECRETS_ENCRYPTION_KEY` is configured, so I will not store the API key in the database. Set `GLOBAL_API_KEY` in the environment instead (or configure the encryption key and retry).')));
    }
    await ctx.deps.settings.setGlobalApiKey(ctx.options.key);
    await audit(ctx, { action: 'api_key_updated' }); // never logs the value
    logger.info('[OWNER] Global API key updated');
    return ctx.reply(eph(embed.owner('API Key Updated', 'The global API key has been stored (encrypted).')));
  },
});

const addslot = defineCommand({
  ...owner, name: 'addslot', description: '[Owner] Add a new Minecraft API slot',
  options: [{ name: 'url', type: 'string', description: 'Base URL of the slot API', required: true, maxLength: 300 }],
  async execute(ctx) {
    await ctx.defer({ ephemeral: true });
    const u = await safeUrl(ctx, ctx.options.url);
    if (!u.ok) return ctx.reply(eph(embed.error('Invalid URL', u.error)));
    const n = await ctx.deps.slots.add(ctx.deps.db, u.url);
    await audit(ctx, { action: 'slot_added', details: { slot: n } });
    return ctx.reply(eph(embed.owner('Slot Added', `**Slot #${n}** has been created.\n\`${u.url}\``)));
  },
});

const editslot = defineCommand({
  ...owner, name: 'editslot', description: '[Owner] Update the URL of an existing slot',
  options: [slotOpt, { name: 'url', type: 'string', description: 'New base URL', required: true, maxLength: 300 }],
  async execute(ctx) {
    await ctx.defer({ ephemeral: true });
    const u = await safeUrl(ctx, ctx.options.url);
    if (!u.ok) return ctx.reply(eph(embed.error('Invalid URL', u.error)));
    const changed = await ctx.deps.slots.updateUrl(ctx.deps.db, ctx.options.slot, u.url);
    if (!changed) return ctx.reply(eph(embed.error('Slot Not Found', `Slot #${ctx.options.slot} does not exist.`)));
    await audit(ctx, { action: 'slot_url_updated', details: { slot: ctx.options.slot } });
    return ctx.reply(eph(embed.owner('Slot Updated', `**Slot #${ctx.options.slot}** URL updated to:\n\`${u.url}\``)));
  },
});

const deleteslot = defineCommand({
  ...owner, name: 'deleteslot', description: '[Owner] Delete a slot',
  options: [{ ...slotOpt, description: 'Slot number to delete' }],
  async execute(ctx) {
    await ctx.defer({ ephemeral: true });
    const { db, slots, confirmations, config } = ctx.deps;
    const n = ctx.options.slot;
    const slot = await slots.getByNumber(db, n);
    if (!slot) return ctx.reply(eph(embed.error('Slot Not Found', `Slot #${n} does not exist.`)));
    const a = await slots.getActiveAssignmentBySlot(db, slot.id);
    const doDelete = async () => {
      const r = await slots.retire(db, n);
      await audit(ctx, { action: 'slot_removed', details: { slot: n, mode: r.mode, released: r.released } });
      return r;
    };
    if (!a) {
      const r = await doDelete();
      return ctx.reply(eph(embed.owner('Slot Deleted', `Slot #${n} ${r.mode === 'RETIRED' ? 'retired (assignment history preserved)' : 'deleted'}.`)));
    }
    const id = confirmations.create({
      userId: ctx.user.id, guildId: ctx.guildId ?? null, description: `delete slot ${n}`,
      run: async (i) => {
        if (!config.bot.superAdmins.has(i.user.id)) return i.update({ embeds: [embed.error('Owner Only', 'Not permitted.')], components: [] }); // re-check at action time
        const r = await doDelete();
        return i.update({ embeds: [embed.owner('Slot Deleted', `Slot #${n} ${r.mode === 'RETIRED' ? 'retired' : 'deleted'} and its assignment released.`)], components: [] });
      },
    });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cf:${id}:y`).setLabel('🗑️ Delete').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`cf:${id}:n`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    );
    return ctx.reply({
      embeds: [embed.warn('Slot Currently Assigned', `Slot #${n} is assigned to:\n**Server:** ${a.server_name || a.server_id}\n**User:** <@${a.discord_user_id}>\n\nThis confirmation expires in 60 seconds.`)],
      components: [row], ephemeral: true,
    });
  },
});

const state = defineCommand({
  ...owner, name: 'state', description: '[Owner] Show slot inventory',
  async execute(ctx) {
    await ctx.defer({ ephemeral: true });
    const { db, slots } = ctx.deps;
    const st = await slots.stats(db);
    const lines = (await slots.getAll(db)).map((s) => {
      const icon = s.health === 'UNHEALTHY' ? '🔴' : s.status === 'ASSIGNED' ? '🟢' : '🔵';
      return `${icon} **Slot ${s.slot_number}** — ${s.status}${s.health === 'UNHEALTHY' ? ' (unhealthy)' : ''}`;
    }).join('\n') || '_No slots configured._';
    return ctx.reply(eph(embed.owner('Slot State', `**Total:** ${st.total} | **Available:** ${st.available} | **Assigned:** ${st.assigned} | **Inactive:** ${st.inactive}\n\n${lines}`)));
  },
});

const health = defineCommand({
  ...owner, name: 'health', description: '[Owner] Run health check on a slot', options: [slotOpt],
  async execute(ctx) {
    await ctx.defer({ ephemeral: true });
    const { db, slots, afkApi } = ctx.deps;
    const slot = await slots.getByNumber(db, ctx.options.slot);
    if (!slot) return ctx.reply(eph(embed.error('Slot Not Found', `Slot #${ctx.options.slot} does not exist.`)));
    const r = await afkApi.healthCheck(slot.url);
    await slots.setHealth(db, slot.slot_number, r.ok); // health never changes assignment state
    return ctx.reply(eph(r.ok
      ? embed.success(`Slot ${slot.slot_number} Healthy`, 'Health endpoint responded successfully.')
      : embed.error(`Slot ${slot.slot_number} Unhealthy`, `Health check failed.\n\`${r.error}\`${slot.status === 'ASSIGNED' ? '\n\nThe slot stays assigned to its server.' : ''}`)));
  },
});

const userinfo = defineCommand({
  ...owner, name: 'userinfo', description: '[Owner] View info about a user',
  options: [{ name: 'user', type: 'user', description: 'Discord user', required: true }],
  async execute(ctx) {
    await ctx.defer({ ephemeral: true });
    const { db, users, subs, slots } = ctx.deps;
    const id = ctx.options.user;
    const user = await users.findByDiscordId(db, id);
    if (!user) return ctx.reply(eph(embed.info('User Not Found', `<@${id}> has no record in the database.`)));
    const sub = await subs.getLatest(db, user.id);
    const a = await slots.getActiveAssignmentByUser(db, user.id);
    return ctx.reply(eph(embed.owner('User Info', [
      `**User:** <@${id}> (\`${id}\`)`,
      `**Validated:** ${user.validated ? '✅ Yes' : '❌ No'}`,
      `**Validated At:** ${user.validated_at ? `<t:${Math.floor(user.validated_at / 1000)}:f>` : 'N/A'}`,
      sub ? `**Subscription:** ${sub.status} — expires <t:${Math.floor(sub.expires_at / 1000)}:f>` : '**Subscription:** None',
      a ? `**Slot:** #${a.slot_number} → Server \`${a.server_id}\`` : '**Slot:** Not assigned',
    ].join('\n'))));
  },
});

const revoke = defineCommand({
  ...owner, name: 'revoke', description: "[Owner] Revoke a user's subscription and release their slot",
  options: [{ name: 'user', type: 'user', description: 'Discord user', required: true }],
  async execute(ctx) {
    await ctx.defer({ ephemeral: true });
    const { db, users, subs, slots } = ctx.deps;
    const user = await users.findByDiscordId(db, ctx.options.user);
    if (!user) return ctx.reply(eph(embed.error('User Not Found', `<@${ctx.options.user}> has no record.`)));
    const released = await db.tx(async (t) => { await subs.revoke(t, user.id); return slots.releaseByUser(t, user.id, 'REVOKED'); });
    await audit(ctx, { action: 'subscription_revoked', targetId: ctx.options.user, details: { slotReleased: released } });
    return ctx.reply(eph(embed.owner('Subscription Revoked', `<@${ctx.options.user}>'s subscription has been revoked${released ? ' and their slot released' : ' (they had no assigned slot)'}.`)));
  },
});

const unassign = defineCommand({
  ...owner, name: 'unassign', description: '[Owner] Force-release a slot from a Discord server',
  options: [{ name: 'serverid', type: 'string', description: 'Discord Server ID', required: true, maxLength: 25 }],
  async execute(ctx) {
    await ctx.defer({ ephemeral: true });
    const { db, slots } = ctx.deps;
    const a = await slots.getActiveAssignmentByServer(db, ctx.options.serverid.trim());
    if (!a) return ctx.reply(eph(embed.error('Not Found', `No active slot assignment found for server \`${ctx.options.serverid}\`.`)));
    await slots.release(db, a.slot_id, 'OWNER_UNASSIGN');
    await audit(ctx, { action: 'slot_unassigned', details: { slot: a.slot_number, serverId: a.server_id } });
    return ctx.reply(eph(embed.owner('Slot Released', `Slot **#${a.slot_number}** has been released from server \`${a.server_id}\`.`)));
  },
});

const renew = defineCommand({
  ...owner, name: 'renew', description: "[Owner] Manually renew a user's subscription",
  options: [{ name: 'user', type: 'user', description: 'Discord user', required: true }],
  async execute(ctx) {
    await ctx.defer({ ephemeral: true });
    const { db, users, subs } = ctx.deps;
    const user = await users.findByDiscordId(db, ctx.options.user);
    if (!user) return ctx.reply(eph(embed.error('User Not Found', `<@${ctx.options.user}> has no record.`)));
    const { subscription } = await db.tx((t) => subs.grant(t, user.id));
    const days = Math.round(subs.durationMs / 86_400_000); // the real configured duration, not a hard-coded 30
    await audit(ctx, { action: 'subscription_renewed', targetId: ctx.options.user, details: { days } });
    return ctx.reply(eph(embed.owner('Subscription Renewed', `<@${ctx.options.user}>'s subscription was extended by ${days} day(s). New expiry: <t:${Math.floor(subscription.expires_at / 1000)}:f>.`)));
  },
});

module.exports = { commands: [setkey, addslot, editslot, deleteslot, state, health, userinfo, revoke, unassign, renew] };
