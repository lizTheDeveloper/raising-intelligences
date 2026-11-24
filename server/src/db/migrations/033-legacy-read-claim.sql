-- A game from before per-game secrets (pre-2.2.0) has no credential anywhere,
-- and nothing its player holds can be verified (the client only ever kept the
-- game id). Its first claim, inside a short migration window, gets a
-- READ-ONLY credential stored here, separate from access_secret_hash, so it
-- can never authorize DELETE, research writes or proven kid links.
ALTER TABLE games ADD COLUMN IF NOT EXISTS legacy_read_hash TEXT;
ALTER TABLE games ADD COLUMN IF NOT EXISTS legacy_claimed_at TIMESTAMPTZ;
