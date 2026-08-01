-- Dark Play Plan 4: reviewable escalation flags. Deliberately SEPARATE from
-- moderation_flags (Tier B block+ban) and concern_events (Tier A, per-scene,
-- never bans) — this table records the cross-game dark-only/no-range RATIO
-- signal (see safety/escalation.ts) for human review. Writing a row here is
-- the entire action: FLAG-FOR-REVIEW ONLY, no ban is ever applied by this
-- code path.
CREATE TABLE IF NOT EXISTS escalation_flags (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_address     TEXT,
  game_id        UUID,
  total_games    INTEGER,
  dark_games     INTEGER,
  ordinary_games INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_escalation_flags_ip_address ON escalation_flags (ip_address);
