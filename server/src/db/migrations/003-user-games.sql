-- Associates Matrix user IDs with games so players can resume across devices.

CREATE TABLE IF NOT EXISTS user_games (
  user_id    TEXT        NOT NULL,
  game_id    UUID        NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  child_name TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, game_id)
);

CREATE INDEX IF NOT EXISTS idx_user_games_user_id ON user_games (user_id);
