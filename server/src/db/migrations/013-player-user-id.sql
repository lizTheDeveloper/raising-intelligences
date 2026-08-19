-- Associate each multiplayer player slot with their Matrix user id (nullable:
-- non-logged-in players have none). Lets the multiplayer endgame group games
-- under the co-parent in each signed-in player's Family Album.
ALTER TABLE players ADD COLUMN IF NOT EXISTS user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_players_user_id ON players (user_id);
