'use strict';

function createUsers({ now = () => Date.now() } = {}) {
  const findByDiscordId = async (q, id) => (await q.query('SELECT * FROM users WHERE discord_user_id = $1', [id])).rows[0] || null;
  const findById = async (q, id) => (await q.query('SELECT * FROM users WHERE id = $1', [id])).rows[0] || null;

  /** Insert or update a user. A placeholder username never overwrites a real one. */
  async function upsert(q, discordUserId, username, { placeholder = false } = {}) {
    const t = now();
    await q.query(
      `INSERT INTO users (discord_user_id, username, created_at, updated_at) VALUES ($1, $2, $3, $3)
       ON CONFLICT (discord_user_id) DO UPDATE SET
         username = CASE WHEN $4 = 1 THEN users.username ELSE excluded.username END,
         updated_at = excluded.updated_at`,
      [discordUserId, username, t, placeholder ? 1 : 0]
    );
    return findByDiscordId(q, discordUserId);
  }

  async function validate(q, discordUserId) {
    const t = now();
    await q.query('UPDATE users SET validated = 1, validated_at = COALESCE(validated_at, $1), updated_at = $1 WHERE discord_user_id = $2', [t, discordUserId]);
  }

  return { findByDiscordId, findById, upsert, validate };
}

module.exports = { createUsers };
