-- Host type on the person (persona tests, Dev): the §9.1 ceiling is a property
-- of who the host is, set once by the admin, not a checkbox on each event.
--   club            no authority over attendees, not a business, not sensitive
--   authority       authority over likely attendees (L1 at most, never codes)
--   events_business a dating or events business (never hosts until Q8a; may promote a studio event)
--   sensitive       a faith or other sensitive-community counsellor (guest reader at a studio event only)
--   studio          studio staff (guest reader at a studio event)
-- NULL: a person added before host types existed. They keep every event they
-- are on, and can't be put on a new one until the admin sets their type.
ALTER TABLE host_people ADD COLUMN IF NOT EXISTS host_type TEXT NULL
  CHECK (host_type IN ('club', 'authority', 'events_business', 'sensitive', 'studio'));
-- The business or group's name. Never shown to players; used to keep a
-- promoting business's name off the card.
ALTER TABLE host_people ADD COLUMN IF NOT EXISTS organisation TEXT NULL CHECK (char_length(organisation) <= 60);

-- Safe backfill, only where an existing event already says what the person is:
-- an outside host of an event with authority -> authority; any other outside
-- host -> club (they could only host by answering no to all three). Guest
-- readers are left unset: nothing recorded says which kind they are.
UPDATE host_people p SET host_type = 'authority'
 WHERE p.host_type IS NULL AND EXISTS (SELECT 1 FROM host_events e WHERE e.host_person_id = p.id AND e.authority);
UPDATE host_people p SET host_type = 'club'
 WHERE p.host_type IS NULL AND EXISTS (SELECT 1 FROM host_events e WHERE e.host_person_id = p.id);

-- People who promote an event (a business sending its list). Refused at the
-- queue and at JOIN_GAME exactly like the host (H12); they see nothing.
ALTER TABLE host_events ADD COLUMN IF NOT EXISTS promoter_ids TEXT[] NOT NULL DEFAULT '{}';
