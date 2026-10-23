-- Self-reported adult flag, adult-only birth year, and per-game access secret
-- hash. All nullable with no default: NULL means "unknown" (legacy games and
-- clients that never sent a birth year), never "false" or "adult". Under-18
-- players get is_adult = false and birth_year stays NULL.
ALTER TABLE games
  ADD COLUMN IF NOT EXISTS birth_year INT,
  ADD COLUMN IF NOT EXISTS is_adult BOOLEAN,
  ADD COLUMN IF NOT EXISTS access_secret_hash TEXT;
