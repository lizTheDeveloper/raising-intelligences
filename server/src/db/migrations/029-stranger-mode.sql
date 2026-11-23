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

-- One row per ID check started: (subject, UTC day, attempt 1..max). The
-- primary key makes taking a slot atomic, so parallel requests can't go over
-- the daily cap (each check costs money).
CREATE TABLE IF NOT EXISTS stranger_check_slots (
  subject   TEXT NOT NULL,
  day       TEXT NOT NULL,
  attempt   INTEGER NOT NULL,
  taken_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (subject, day, attempt)
);

-- One document, one account: a keyed hash (never the number itself) of the
-- ID document that passed, bound to the account it first passed for.
CREATE TABLE IF NOT EXISTS stranger_documents (
  doc_hash  TEXT PRIMARY KEY,
  subject   TEXT NOT NULL,
  bound_at  TIMESTAMPTZ NOT NULL
);
