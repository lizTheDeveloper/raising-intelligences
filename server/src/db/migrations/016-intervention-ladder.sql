-- Dark Play Plan 3: intervention-ladder state persisted per game.
ALTER TABLE games ADD COLUMN IF NOT EXISTS highest_rung_fired INTEGER NOT NULL DEFAULT 0;
ALTER TABLE games ADD COLUMN IF NOT EXISTS cps_outcome TEXT;
ALTER TABLE games ADD COLUMN IF NOT EXISTS therapy_messages JSONB NOT NULL DEFAULT '[]'::jsonb;
