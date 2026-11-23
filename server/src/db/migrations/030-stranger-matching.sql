-- Stranger mode matching: which account each seat of a stranger game belongs
-- to (only those two can ever sit in it), pairs that must never be matched
-- again, and accounts held out of the pool pending review. Accounts appear
-- only as `subject` (an HMAC of the Matrix id).

CREATE TABLE IF NOT EXISTS stranger_runs (
  game_id          TEXT PRIMARY KEY,
  meetup_code      TEXT,
  parent1_subject  TEXT NOT NULL,
  parent2_subject  TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS stranger_blocks (
  subject_a   TEXT NOT NULL,
  subject_b   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (subject_a, subject_b),
  CHECK (subject_a < subject_b)
);

CREATE TABLE IF NOT EXISTS stranger_suspensions (
  subject     TEXT PRIMARY KEY,
  reason      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL
);
