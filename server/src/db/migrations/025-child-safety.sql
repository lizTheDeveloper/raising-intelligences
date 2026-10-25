-- Child-safety evidence vault. See server/src/safety/child-safety/ and
-- docs/child-safety.md.
--
-- A separate schema, not public, for three reasons:
--   1. No foreign key to games: a case survives game deletion, research
--      deletion (deleteGameData) and IP unbans. Evidence is copied in, never
--      referenced.
--   2. Access can be restricted at the schema level. PUBLIC gets nothing;
--      only the owning (application) role can read it, so a future read-only
--      analytics role granted on public cannot see it.
--   3. The research-privacy test that requires every public game_id table
--      to be wiped on deletion does not apply here, on purpose.
--
-- The evidence itself (content, context, user agent, scores) is only ever
-- stored as AES-256-GCM ciphertext; the key is in the container env, not here.

CREATE SCHEMA IF NOT EXISTS child_safety;
REVOKE ALL ON SCHEMA child_safety FROM PUBLIC;

CREATE TABLE IF NOT EXISTS child_safety.evidence_cases (
  id                 UUID PRIMARY KEY,
  source             TEXT        NOT NULL,
  status             TEXT        NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open', 'dismissed', 'confirmed', 'reported', 'released')),
  categories         TEXT[]      NOT NULL DEFAULT '{}',
  game_ref           TEXT,
  ip_address         TEXT,
  identifiers        JSONB       NOT NULL DEFAULT '[]',
  incident_at        TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  content_sha256     TEXT        NOT NULL,
  key_id             TEXT        NOT NULL,
  ciphertext         TEXT        NOT NULL,
  external_ref       TEXT UNIQUE,
  is_test            BOOLEAN     NOT NULL DEFAULT false,
  locked             BOOLEAN     NOT NULL DEFAULT false,
  retain_until       TIMESTAMPTZ,
  purge_after        TIMESTAMPTZ,
  dismissed_at       TIMESTAMPTZ,
  dismissed_by       TEXT,
  dismiss_reason     TEXT,
  confirmed_at       TIMESTAMPTZ,
  confirmed_by       TEXT,
  reported_at        TIMESTAMPTZ,
  reported_by        TEXT,
  cybertip_report_id TEXT,
  -- An open, confirmed or reported case can never be purgeable.
  CHECK (status IN ('dismissed', 'released') OR purge_after IS NULL),
  CHECK (status NOT IN ('confirmed', 'reported') OR locked)
);
CREATE INDEX IF NOT EXISTS idx_cs_cases_status ON child_safety.evidence_cases (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cs_cases_purge ON child_safety.evidence_cases (purge_after) WHERE purge_after IS NOT NULL;

-- Every read of, or change to, a case. No foreign key: purge rows outlive the case.
CREATE TABLE IF NOT EXISTS child_safety.access_log (
  id        BIGSERIAL PRIMARY KEY,
  case_id   UUID,
  actor     TEXT        NOT NULL,
  action    TEXT        NOT NULL,
  actor_ip  TEXT,
  detail    TEXT,
  at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cs_access_case ON child_safety.access_log (case_id, at);

-- IP + time for every game create, join and parent message, so a flag raised
-- later (the scene reader runs at scene end) still has the IPs. 90-day
-- retention, enforced by the purge sweep.
CREATE TABLE IF NOT EXISTS child_safety.ip_log (
  id          BIGSERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip          TEXT        NOT NULL,
  game_ref    TEXT,
  event       TEXT        NOT NULL,
  -- Which seat produced the row (parent1 / parent2), so a confirmed case
  -- bans and reports only the flagged sender, never a co-player.
  slot        TEXT,
  user_agent  TEXT,
  account_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_cs_ip_log_game ON child_safety.ip_log (game_ref, at);
CREATE INDEX IF NOT EXISTS idx_cs_ip_log_at ON child_safety.ip_log (at);

-- Identifiers banned by a confirmed case, which locks them against unban.
-- Only verified identifiers ever land here: a server-observed IP, or an
-- authenticated account. RI's Matrix IDs are client-claimed and never do.
CREATE TABLE IF NOT EXISTS child_safety.banned_identifiers (
  kind        TEXT        NOT NULL,
  value       TEXT        NOT NULL,
  reason      TEXT        NOT NULL,
  case_id     UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, value)
);

REVOKE ALL ON ALL TABLES IN SCHEMA child_safety FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA child_safety FROM PUBLIC;
