-- Feature modules: invites, allowlists, security events, fun, announcements, economy.

CREATE TABLE invite_attributions (
  id {{PK}},
  guild_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  inviter_id TEXT,
  invite_code TEXT,
  attribution TEXT NOT NULL DEFAULT 'UNKNOWN',
  account_created_at BIGINT,
  joined_at BIGINT NOT NULL,
  left_at BIGINT,
  active SMALLINT NOT NULL DEFAULT 1
);
-- One open join session per member: duplicate join events cannot double-count.
CREATE UNIQUE INDEX uq_invite_open_member ON invite_attributions(guild_id, member_id) WHERE active = 1;
CREATE INDEX idx_invite_inviter ON invite_attributions(guild_id, inviter_id);

CREATE TABLE bot_access_allowlist (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  added_by TEXT NOT NULL,
  added_at BIGINT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE antinuke_allowlist (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  added_by TEXT NOT NULL,
  added_at BIGINT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE security_events (
  id {{PK}},
  guild_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_id TEXT,
  target_id TEXT,
  evidence TEXT,
  action_taken TEXT,
  outcome TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX idx_security_guild_time ON security_events(guild_id, created_at);

-- guild_id = '*' stores the global default; other values are per-guild overrides.
CREATE TABLE fun_responses (
  id {{PK}},
  guild_id TEXT NOT NULL,
  action TEXT NOT NULL,
  message_template TEXT,
  media_url TEXT,
  source TEXT NOT NULL DEFAULT 'direct',
  provider_query TEXT,
  enabled SMALLINT NOT NULL DEFAULT 1,
  updated_by TEXT,
  updated_at BIGINT NOT NULL,
  UNIQUE (guild_id, action)
);

CREATE TABLE announcement_deliveries (
  id {{PK}},
  source_message_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at BIGINT NOT NULL,
  delivered_at BIGINT,
  UNIQUE (source_message_id, guild_id)
);

-- DarkEssence (DE): global per-user balance; independent of AFK payments.
CREATE TABLE economy_accounts (
  user_id TEXT PRIMARY KEY,
  balance BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE economy_transactions (
  id {{PK}},
  user_id TEXT NOT NULL,
  delta BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  reason TEXT NOT NULL,
  ref_key TEXT UNIQUE,
  created_at BIGINT NOT NULL
);
CREATE INDEX idx_econ_tx_user ON economy_transactions(user_id, created_at);
