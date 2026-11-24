-- Kofi's portal (persona tests): the host can see their meetup link again.
-- An event code is derived from the server's pepper, the event id and this
-- count of replacements, so it is never stored in the clear (only its keyed
-- hash, as before). "get a new link" bumps the count; the old code stops.
-- Existing rows keep NULL: their random codes were shown once and kept by
-- nobody, so the portal offers "get a new link" for them instead.
ALTER TABLE host_events ADD COLUMN IF NOT EXISTS code_seq INTEGER NULL;
