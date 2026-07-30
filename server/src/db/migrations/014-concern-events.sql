-- Tier A "concern" events: dark-but-in-fiction parenting the intervention system
-- reacts to. Deliberately SEPARATE from moderation_flags (which is Tier B
-- block+ban only) so the two are never conflated again.
CREATE TABLE IF NOT EXISTS concern_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id     UUID NOT NULL,
  sender      TEXT NOT NULL,
  reason      TEXT NOT NULL,
  ip_address  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_concern_events_game_id ON concern_events (game_id);
