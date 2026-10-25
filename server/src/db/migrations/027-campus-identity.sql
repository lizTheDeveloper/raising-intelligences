-- Campus web cabinets (docs/child-safety.md "Verified campus identity").
--
-- A student playing inside a campus.themultiverse.school web cabinet trades
-- campus's signed launch pass (POST /api/campus-pass) for an opaque identity
-- token. Only the token's SHA-256 is stored, with the campus Matrix id it
-- stands for; it lasts 12 hours so a server restart doesn't sign anyone out.
-- No game_id: an identity is not game data (deleteGameData leaves it alone,
-- and it expires on its own).
CREATE TABLE IF NOT EXISTS campus_identities (
  token_hash  TEXT        PRIMARY KEY,
  sub         TEXT        NOT NULL,
  name        TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_campus_identities_expires ON campus_identities (expires_at);

-- Spent campus pass jtis, so a pass is single-use across restarts and
-- processes. Rows are kept until the pass expires (≤ 5 minutes), then pruned.
CREATE TABLE IF NOT EXISTS campus_pass_jti (
  jti     TEXT        PRIMARY KEY,
  exp_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_campus_pass_jti_exp ON campus_pass_jti (exp_at);

-- The verified campus id behind a game. games.campus_sub is the creator of a
-- solo (seatless) game, who types for both parents; players.campus_sub is a
-- multiplayer seat's own. Both go with their row on deletion.
ALTER TABLE games ADD COLUMN IF NOT EXISTS campus_sub TEXT;
ALTER TABLE players ADD COLUMN IF NOT EXISTS campus_sub TEXT;

-- An IP-log account id the server verified itself (a campus identity from a
-- launch pass), as opposed to a client-claimed Matrix userId. A verified row
-- becomes a vault identifier of kind 'campus' (bannable); an unverified one
-- kind 'matrix' (evidence only).
ALTER TABLE child_safety.ip_log ADD COLUMN IF NOT EXISTS account_verified BOOLEAN NOT NULL DEFAULT false;
