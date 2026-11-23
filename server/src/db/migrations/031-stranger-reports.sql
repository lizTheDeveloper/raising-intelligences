-- Stranger mode reports. Accounts appear only as subjects (HMACs of Matrix
-- ids). An `open` report suspends the reported account (stranger_suspensions)
-- and blocks the pair (stranger_blocks) until an admin reviews it. A
-- `counter` report (filed back by a seat that had itself been reported) is
-- reviewed but never suspends anyone by itself. One report per seat per game.
CREATE TABLE IF NOT EXISTS stranger_reports (
  id                TEXT PRIMARY KEY,
  game_id           TEXT NOT NULL,
  reporter_subject  TEXT NOT NULL,
  reported_subject  TEXT NOT NULL,
  reason            TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('open', 'counter', 'lifted', 'kept', 'dismissed')),
  UNIQUE (game_id, reporter_subject)
);
CREATE INDEX IF NOT EXISTS stranger_reports_reported ON stranger_reports (reported_subject);
