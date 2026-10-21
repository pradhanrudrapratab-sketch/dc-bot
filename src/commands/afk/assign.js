'use strict';
const { defineCommand } = require('../../framework/command');
const { embed } = require('../../utils/embeds');
const audit = (ctx, a) => ctx.deps.audit.record({ guildId: ctx.guildId, category: 'config', ...a });

module.exports = defineCommand({
  name: 'assign', description: 'Assign your subscription slot to this Discord server', category: 'afk', prefix: false,
  userPermissions: ['Administrator'],
  async execute(ctx) {
    await ctx.defer({ ephemeral: true });
    const { db, users, subs, slots } = ctx.deps;
    const fail = (title, text) => ctx.reply({ embeds: [embed.error(title, text)], ephemeral: true });

    const user = await users.findByDiscordId(db, ctx.user.id);
    if (!user || !user.validated) return fail('Not Validated', 'You do not have an active subscription.\n\nPlease make the required OwO payment in the **Master Discord Server**.');
    if (!(await subs.getActive(db, user.id))) return fail('Subscription Expired', 'Your subscription has expired.\n\nPlease renew in the **Master Discord Server**.');

    // Atomic: slot selection + assignment in one transaction; unique indexes make double-claims impossible.
    const r = await slots.claim(db, { userId: user.id, serverId: ctx.guildId, serverName: ctx.guild?.name });
    if (!r.ok) {
      if (r.reason === 'USER_HAS_SLOT') {
        return r.existing.server_id === ctx.guildId
          ? ctx.reply({ embeds: [embed.info('Already Assigned', `Slot **#${r.existing.slot_number}** is already assigned to this server.`)], ephemeral: true })
          : fail('Slot Already Assigned', `Your slot **#${r.existing.slot_number}** is currently assigned to another server.\n\nContact the bot owner to reassign or release it.`);
      }
      if (r.reason === 'SERVER_HAS_SLOT') return fail('Server Already Has a Slot', 'This server already has an active slot assignment.');
      return fail('Slots Not Available', 'There are currently no available slots.\n\nPlease DM the administrator to add more slots.');
    }
    await audit(ctx, { action: 'slot_assigned', actorId: ctx.user.id, details: { slot: r.slot.slot_number } });
    return ctx.reply({
      embeds: [embed.success('Slot Assigned', `**Slot:** #${r.slot.slot_number}\n**Server:** ${ctx.guild?.name}\n\nServer administrators can now control the Minecraft AFK bot using \`/start\`, \`/stop\`, and other commands.\n\nUse \`/status\` to see quick-action buttons.`)],
      ephemeral: true,
    });
  },
});
