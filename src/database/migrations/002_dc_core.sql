-- DC Bot shared infrastructure: per-guild settings, audit trail, warnings, permission monitor.

CREATE TABLE guild_settings (
  guild_id TEXT PRIMARY KEY,
  prefix TEXT NOT NULL DEFAULT '!',
  verification_enabled SMALLINT NOT NULL DEFAULT 0,
  verification_channel_id TEXT,
  verification_role_id TEXT,
  verification_message_id TEXT,
  verification_lockdown TEXT,
  honeypot_enabled SMALLINT NOT NULL DEFAULT 0,
  honeypot_channel_id TEXT,
  honeypot_message_id TEXT,
  honeypot_tamper_action TEXT NOT NULL DEFAULT 'alert',
  announcement_channel_id TEXT,
  invite_tracking_enabled SMALLINT NOT NULL DEFAULT 0,
  invite_log_channel_id TEXT,
  antinuke_enabled SMALLINT NOT NULL DEFAULT 0,
  botguard_enabled SMALLINT NOT NULL DEFAULT 0,
  botguard_fallback TEXT NOT NULL DEFAULT 'alert',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE global_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE audit_logs (
  id {{PK}},
  guild_id TEXT,
  category TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_id TEXT,
  target_id TEXT,
  result TEXT NOT NULL DEFAULT 'SUCCESS',
  details TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX idx_audit_guild_time ON audit_logs(guild_id, created_at);
CREATE INDEX idx_audit_category ON audit_logs(category);

CREATE TABLE log_settings (
  guild_id TEXT NOT NULL,
  category TEXT NOT NULL,
  channel_id TEXT,
  enabled SMALLINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (guild_id, category)
);

-- Immutable warning history (never deleted by the 30-day reset).
CREATE TABLE warnings (
  id {{PK}},
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  moderator_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  active_count_after INTEGER NOT NULL,
  escalation_action TEXT,
  escalation_status TEXT,
  escalation_error TEXT
);
CREATE INDEX idx_warnings_member ON warnings(guild_id, user_id, created_at);

-- Mutable summary: only active_count/last_warning_at change on reset.
CREATE TABLE warning_state (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  active_count INTEGER NOT NULL DEFAULT 0,
  last_warning_at BIGINT,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE permission_state (
  guild_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  blocked SMALLINT NOT NULL DEFAULT 0,
  missing TEXT,
  notified_at BIGINT,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (guild_id, feature)
);
