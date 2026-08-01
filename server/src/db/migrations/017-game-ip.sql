-- Dark Play Plan 4: record the creating IP on games. This is the denominator
-- prerequisite for escalation detection — without an IP-on-games column, an
-- IP's clean (non-flagged) games are invisible, and any escalation signal
-- built only from moderation_flags/concern_events would be a raw count, not
-- a ratio (the unsafe shape Plan 1 had to reverse). Nullable — historical
-- games have none, which is fail-safe toward NOT flagging (see
-- safety/escalation.ts: a null IP never evaluates).
ALTER TABLE games ADD COLUMN IF NOT EXISTS ip_address TEXT;
