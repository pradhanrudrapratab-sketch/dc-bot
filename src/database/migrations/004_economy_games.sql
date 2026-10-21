-- Per-user game state for the DarkEssence economy (daily streak + coin-flip counter).
CREATE TABLE economy_state (
  user_id TEXT PRIMARY KEY,
  last_daily_at BIGINT,
  daily_streak INTEGER NOT NULL DEFAULT 0,
  coinflip_count BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL
);
