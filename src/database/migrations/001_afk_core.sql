-- Minecraft AFK subscription core (ported from the SQLite schema, hardened).
-- All timestamps are BIGINT epoch milliseconds (UTC). No string/ISO comparisons anywhere.

CREATE TABLE users (
  id {{PK}},
  discord_user_id TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL,
  validated SMALLINT NOT NULL DEFAULT 0,
  validated_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE payments (
  id {{PK}},
  payment_message_id TEXT NOT NULL UNIQUE,
  sender_id TEXT NOT NULL,
  receiver_id TEXT NOT NULL,
  amount BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  subscription_id BIGINT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at BIGINT NOT NULL,
  processed_at BIGINT,
  updated_at BIGINT NOT NULL
);
CREATE INDEX idx_payments_status ON payments(status);

CREATE TABLE subscriptions (
  id {{PK}},
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  started_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX idx_subscriptions_user ON subscriptions(user_id);
CREATE UNIQUE INDEX uq_subscriptions_one_active ON subscriptions(user_id) WHERE status = 'ACTIVE';

CREATE TABLE slots (
  id {{PK}},
  slot_number INTEGER NOT NULL UNIQUE,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'AVAILABLE',
  health TEXT NOT NULL DEFAULT 'UNKNOWN',
  last_health_at BIGINT,
  retired_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX idx_slots_status ON slots(status);

CREATE TABLE slot_assignments (
  id {{PK}},
  slot_id BIGINT NOT NULL REFERENCES slots(id) ON DELETE RESTRICT,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL,
  server_name TEXT,
  assigned_at BIGINT NOT NULL,
  released_at BIGINT,
  release_reason TEXT
);
CREATE UNIQUE INDEX uq_assignment_active_slot ON slot_assignments(slot_id) WHERE released_at IS NULL;
CREATE UNIQUE INDEX uq_assignment_active_server ON slot_assignments(server_id) WHERE released_at IS NULL;
CREATE UNIQUE INDEX uq_assignment_active_user ON slot_assignments(user_id) WHERE released_at IS NULL;

CREATE TABLE configuration (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);

-- Encrypted secrets (AES-256-GCM, key from SECRETS_ENCRYPTION_KEY). Never plaintext.
CREATE TABLE secrets (
  name TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);
