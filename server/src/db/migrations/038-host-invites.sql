-- Host onboarding (persona tests, S2-5). The admin invites a host or guest
-- reader; the person opens the link, signs in, passes the 18+ check and
-- agrees to the host terms, and only then becomes a host_people row. The
-- token is shown to the admin once and kept only as a keyed hash.
CREATE TABLE IF NOT EXISTS host_invites (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 60),
  host_type     TEXT NOT NULL CHECK (host_type IN ('club', 'authority', 'events_business', 'sensitive', 'studio')),
  organisation  TEXT NULL CHECK (char_length(organisation) <= 60),
  created_at    BIGINT NOT NULL,
  expires_at    BIGINT NOT NULL,
  used_at       BIGINT NULL,
  person_id     TEXT NULL REFERENCES host_people(id),
  revoked_at    BIGINT NULL
);

-- A person the admin adds directly has no agreement on record until they
-- agree in the portal, or the admin records one they signed. Rows from before
-- keep the time they were added (what the admin recorded then).
ALTER TABLE host_people ALTER COLUMN agreement_version DROP NOT NULL;
ALTER TABLE host_people ALTER COLUMN agreement_at DROP NOT NULL;
