'use strict';

const EPHEMERAL = 64; // MessageFlags.Ephemeral

/** Normalise `ephemeral: true` into the flags form discord.js 14.16+ expects. */
function normalize(payload) {
  const { ephemeral, ...rest } = payload || {};
  if (ephemeral) rest.flags = (rest.flags || 0) | EPHEMERAL;
  return rest;
}

/**
 * Send a response on an interaction using the *correct* method for its current state:
 *   fresh -> reply, deferred -> editReply, already replied -> followUp.
 * Fixes the old "reply() after deferReply()" crash. Always awaited by callers.
 */
async function respond(interaction, payload) {
  const p = normalize(payload);
  if (interaction.replied) return interaction.followUp(p);
  if (interaction.deferred) {
    const { flags, ...editable } = p; // ephemeral state is fixed at defer time
    return interaction.editReply(editable);
  }
  return interaction.reply(p);
}

module.exports = { respond, normalize, EPHEMERAL };
