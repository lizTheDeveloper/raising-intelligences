-- Who paused an event. A studio (admin) pause is a safety control: a host can
-- never lift it, only a pause the host made. A paused row from before this
-- column counts as the studio's.
ALTER TABLE host_events ADD COLUMN IF NOT EXISTS paused_by TEXT NULL CHECK (paused_by IN ('admin', 'host'));
UPDATE host_events SET paused_by = 'admin' WHERE paused AND paused_by IS NULL;
