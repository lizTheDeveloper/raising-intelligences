-- Add a reconnection token so returning players can reclaim their slot
-- after a disconnect or server restart.
ALTER TABLE players ADD COLUMN IF NOT EXISTS token TEXT;
CREATE INDEX IF NOT EXISTS idx_players_game_token ON players (game_id, token);
