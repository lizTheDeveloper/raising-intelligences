-- Album feature: partners, moments, and game-partner linking.

CREATE TABLE IF NOT EXISTS album_partners (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               TEXT        NOT NULL,
  partner_name          TEXT        NOT NULL,
  partner_type          TEXT        NOT NULL DEFAULT 'real',
  relationship_summary  TEXT        NOT NULL DEFAULT '',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, partner_name, partner_type)
);

CREATE INDEX IF NOT EXISTS idx_album_partners_user_id ON album_partners (user_id);

CREATE TABLE IF NOT EXISTS album_moments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id     UUID        NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  age         INTEGER     NOT NULL,
  title       TEXT        NOT NULL,
  description TEXT        NOT NULL,
  moment_type TEXT        NOT NULL,
  image_path  TEXT,
  sort_order  INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_album_moments_game_id ON album_moments (game_id);

ALTER TABLE user_games ADD COLUMN IF NOT EXISTS partner_id UUID REFERENCES album_partners(id);
