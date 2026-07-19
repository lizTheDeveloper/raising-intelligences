-- Index moderation_flags by ip_address for the repeat-offender ban check
-- (COUNT(DISTINCT game_id) WHERE ip_address = $1) and the admin review queue's
-- per-IP ban-state enrichment. See safety/moderation.ts and routes/admin.ts.
CREATE INDEX IF NOT EXISTS idx_moderation_flags_ip_address
  ON moderation_flags (ip_address);
