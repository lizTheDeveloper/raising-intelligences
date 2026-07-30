-- Dark Play Plan 2: persisted bounded concern accumulator per game.
-- Rises on a scene-end Tier A "concern" verdict, decays on a clean scene.
-- Server-only; drives the intervention ladder (Plan 3) and epilogue branching.
ALTER TABLE games ADD COLUMN IF NOT EXISTS concern_level INTEGER NOT NULL DEFAULT 0;
