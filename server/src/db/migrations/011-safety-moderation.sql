-- Safety moderation: flagged parent messages (full content, for review) and
-- a banned-IP list. See server/src/safety/moderation.ts.

CREATE TABLE IF NOT EXISTS moderation_flags (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id     UUID        NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  sender      TEXT        NOT NULL,
  content     TEXT        NOT NULL,
  reason      TEXT        NOT NULL,
  ip_address  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_moderation_flags_game_id ON moderation_flags (game_id);
CREATE INDEX IF NOT EXISTS idx_moderation_flags_created_at ON moderation_flags (created_at);

CREATE TABLE IF NOT EXISTS banned_ips (
  ip_address  TEXT PRIMARY KEY,
  reason      TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
