-- Stranger mode (Tier 4): consent, age verification outcomes.
-- Accounts appear only as `subject`, an HMAC of the Matrix id. No date of
-- birth, name or document data is stored anywhere: only the outcome.

CREATE TABLE IF NOT EXISTS stranger_consents (
  subject       TEXT PRIMARY KEY,
  version       TEXT NOT NULL,
  consented_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS stranger_verification_sessions (
  session_id  TEXT PRIMARY KEY,
  subject     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS stranger_verification_sessions_subject ON stranger_verification_sessions (subject, created_at DESC);

CREATE TABLE IF NOT EXISTS stranger_age_verifications (
  subject      TEXT PRIMARY KEY,
  outcome      TEXT NOT NULL CHECK (outcome IN ('adult', 'minor')),
  livemode     BOOLEAN NOT NULL,
  verified_at  TIMESTAMPTZ NOT NULL,
  session_id   TEXT NOT NULL
);
