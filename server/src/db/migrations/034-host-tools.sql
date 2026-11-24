-- Meetup host tools, prototype (spec: docs/superpowers/specs/2026-11-23-meetup-host-tools-design.md, build plan B.1).
-- People appear only as `subject`, the same HMAC of the Matrix id as every
-- stranger record. No event code and no share code is stored in the clear:
-- only keyed hashes. Times are ms since epoch (BIGINT), as in the spec.

-- A person who can host an event or read its share codes. Created by Liz.
CREATE TABLE IF NOT EXISTS host_people (
  id                TEXT PRIMARY KEY,
  subject           TEXT NOT NULL UNIQUE,
  display_name      TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 60),
  role_text         TEXT NULL CHECK (char_length(role_text) <= 80),
  -- What Liz checked. role_text is shown only when both of these are set (H16).
  role_checked      TEXT NULL,
  role_checked_at   BIGINT NULL,
  agreement_version TEXT NOT NULL,
  agreement_at      BIGINT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('approved', 'suspended', 'closed')),
  created_at        BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS host_events (
  id               TEXT PRIMARY KEY,
  -- Keyed hash of the event code; the plaintext is shown to the admin once.
  code_hash        TEXT NOT NULL UNIQUE,
  -- 'env': a code listed in RI_MEETUP_CODES, kept as a studio L0 event.
  source           TEXT NOT NULL DEFAULT 'admin' CHECK (source IN ('admin', 'env')),
  name             TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  kind             TEXT NOT NULL CHECK (kind IN ('studio', 'outside')),
  host_person_id   TEXT NULL REFERENCES host_people(id),
  guest_reader_id  TEXT NULL REFERENCES host_people(id),
  sensitive        BOOLEAN NOT NULL,
  authority        BOOLEAN NOT NULL,
  events_business  BOOLEAN NOT NULL,
  level            SMALLINT NOT NULL CHECK (level IN (0, 1, 3)),
  share_codes      BOOLEAN NOT NULL DEFAULT false,
  studio_learning  BOOLEAN NOT NULL DEFAULT false,
  handle_exchange  BOOLEAN NOT NULL,
  welcome_text     TEXT NOT NULL DEFAULT '' CHECK (char_length(welcome_text) <= 600),
  length_text      TEXT NULL CHECK (char_length(length_text) <= 60),
  conduct_url      TEXT NULL,
  capacity         INT NOT NULL CHECK (capacity BETWEEN 1 AND 500),
  join_window_ms   INT NOT NULL CHECK (join_window_ms > 0),
  opens_at         BIGINT NOT NULL,
  closes_at        BIGINT NOT NULL,
  paused           BOOLEAN NOT NULL DEFAULT false,
  closed_at        BIGINT NULL,
  card_version     INT NOT NULL DEFAULT 1,
  -- {cost, traceLine, traceWhere, handleExchange, learning}: set at the first acknowledgement (H17).
  frozen_terms     JSONB NULL,
  first_ack_at     BIGINT NULL,
  -- Set once, at least 24h after close, never recomputed.
  published_funnel JSONB NULL,
  published_at     BIGINT NULL,
  created_at       BIGINT NOT NULL,
  CHECK (closes_at > opens_at AND closes_at - opens_at <= 14::BIGINT * 24 * 3600 * 1000),
  -- The ceilings (spec §9.1), enforced again in code.
  CHECK (NOT (kind = 'outside' AND sensitive)),
  CHECK (NOT (kind = 'outside' AND events_business)),
  CHECK (NOT (authority AND (level = 3 OR share_codes))),
  CHECK (NOT (kind = 'studio' AND (host_person_id IS NOT NULL OR sensitive))),
  CHECK (NOT (kind = 'outside' AND (guest_reader_id IS NOT NULL OR studio_learning))),
  CHECK (NOT (kind = 'outside' AND host_person_id IS NULL)),
  CHECK (share_codes = (level = 3)),
  CHECK (NOT (kind = 'studio' AND level = 3 AND guest_reader_id IS NULL)),
  CHECK (NOT (events_business AND handle_exchange))
);

-- The card as it stood at each version, so a player can see exactly what they agreed to.
CREATE TABLE IF NOT EXISTS host_event_cards (
  event_id     TEXT NOT NULL REFERENCES host_events(id),
  card_version INT NOT NULL,
  card         JSONB NOT NULL,
  PRIMARY KEY (event_id, card_version)
);

-- "continue" on the card. Recorded against a random pre-subject token, bound
-- to the subject when the player signs in for a stranger pass.
CREATE TABLE IF NOT EXISTS host_event_acks (
  id             TEXT PRIMARY KEY,
  event_id       TEXT NOT NULL REFERENCES host_events(id),
  card_version   INT NOT NULL,
  pre_token_hash TEXT NOT NULL UNIQUE,
  subject        TEXT NULL,
  at             BIGINT NOT NULL,
  bound_at       BIGINT NULL,
  -- First time this subject joined the queue at this event (the funnel's "joined").
  queued_at      BIGINT NULL,
  -- "remove from my list": kept, unlisted, until its retention ends.
  unlisted_at    BIGINT NULL
);
CREATE INDEX IF NOT EXISTS host_event_acks_subject ON host_event_acks (subject, event_id);

ALTER TABLE stranger_runs ADD COLUMN IF NOT EXISTS event_id TEXT NULL REFERENCES host_events(id);
-- When the report card was reached: "games finished", and the start of the share window.
ALTER TABLE stranger_runs ADD COLUMN IF NOT EXISTS finished_at BIGINT NULL;
CREATE INDEX IF NOT EXISTS stranger_runs_event ON stranger_runs (event_id);

-- One per seat per game. Deleted when a code is made or the window closes.
CREATE TABLE IF NOT EXISTS share_decisions (
  game_id        TEXT NOT NULL,
  slot           TEXT NOT NULL CHECK (slot IN ('parent1', 'parent2')),
  answer         TEXT NOT NULL CHECK (answer IN ('yes', 'no', 'later')),
  at             BIGINT NOT NULL,
  window_ends_at BIGINT NOT NULL,
  PRIMARY KEY (game_id, slot)
);

CREATE TABLE IF NOT EXISTS share_codes (
  id           TEXT PRIMARY KEY,
  game_id      TEXT NOT NULL UNIQUE,
  event_id     TEXT NOT NULL REFERENCES host_events(id),
  -- HMAC(pepper, words); words = derive(RI_SHARE_CODE_SECRET, id), never stored.
  code_hash    TEXT NOT NULL UNIQUE,
  -- {reportCard: string|null, epilogue: string|null, reportCardOmitted: bool}
  snapshot     JSONB NOT NULL,
  visible_at   BIGINT NOT NULL,
  expires_at   BIGINT NOT NULL,
  redeemed_by  TEXT NULL REFERENCES host_people(id),
  redeemed_at  BIGINT NULL,
  access_until BIGINT NULL,
  stopped_at   BIGINT NULL,
  -- Which seat stopped it: shown only to that seat ("you stopped this code").
  stopped_by   TEXT NULL CHECK (stopped_by IN ('parent1', 'parent2'))
);

CREATE TABLE IF NOT EXISTS share_access_log (
  code_id        TEXT NOT NULL REFERENCES share_codes(id) ON DELETE CASCADE,
  host_person_id TEXT NOT NULL,
  opened_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS share_access_log_code ON share_access_log (code_id);

CREATE TABLE IF NOT EXISTS studio_learning_choices (
  game_id TEXT NOT NULL,
  slot    TEXT NOT NULL CHECK (slot IN ('parent1', 'parent2')),
  answer  TEXT NOT NULL CHECK (answer IN ('yes', 'no')),
  at      BIGINT NOT NULL,
  PRIMARY KEY (game_id, slot)
);

-- "report this host": no account needed.
CREATE TABLE IF NOT EXISTS host_reports (
  id       TEXT PRIMARY KEY,
  event_id TEXT NULL,
  text     TEXT NOT NULL CHECK (char_length(text) BETWEEN 1 AND 2000),
  at       BIGINT NOT NULL,
  status   TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done'))
);

-- "take my game off my account". Done by an admin (spec §6).
CREATE TABLE IF NOT EXISTS unlink_requests (
  id      TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  at      BIGINT NOT NULL,
  done_at BIGINT NULL
);
