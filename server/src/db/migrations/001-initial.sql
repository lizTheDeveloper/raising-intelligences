-- Initial schema for Raising Intelligences.
-- Tables track persistent game state so that in-memory sessions can be
-- reconstructed from the latest checkpoint on reconnect.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS games (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  child_name           TEXT        NOT NULL,
  relationship_type    TEXT        NOT NULL DEFAULT 'co-parents',
  phase                TEXT        NOT NULL,
  current_event_number INTEGER     NOT NULL DEFAULT 0,
  total_events         INTEGER     NOT NULL DEFAULT 10,
  identity_document    TEXT        NOT NULL DEFAULT '',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS players (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id     UUID        NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  -- 'parent1' | 'parent2'
  slot        TEXT        NOT NULL,
  display_name TEXT,
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (game_id, slot)
);

CREATE TABLE IF NOT EXISTS events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id      UUID        NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  event_number INTEGER     NOT NULL,
  age          INTEGER     NOT NULL,
  description  TEXT        NOT NULL,
  setting      TEXT        NOT NULL,
  trigger      TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (game_id, event_number)
);

CREATE TABLE IF NOT EXISTS messages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id    UUID        NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  -- 'parent1' | 'parent2' | 'kid'
  sender     TEXT        NOT NULL,
  content    TEXT        NOT NULL,
  -- 'shared' | 'private' | 'debrief'
  chat_type  TEXT        NOT NULL,
  visible_to JSONB       NOT NULL DEFAULT '[]'::jsonb,
  -- epoch millis from the in-memory Message.timestamp
  timestamp  BIGINT      NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS identity_snapshots (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id      UUID        NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  event_number INTEGER     NOT NULL,
  document     TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (game_id, event_number)
);

CREATE TABLE IF NOT EXISTS endgames (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id     UUID        NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  epilogue    TEXT        NOT NULL DEFAULT '',
  report_card TEXT        NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (game_id)
);

CREATE INDEX IF NOT EXISTS idx_players_game_id            ON players (game_id);
CREATE INDEX IF NOT EXISTS idx_events_game_id             ON events (game_id);
CREATE INDEX IF NOT EXISTS idx_messages_game_id           ON messages (game_id);
CREATE INDEX IF NOT EXISTS idx_messages_game_id_timestamp ON messages (game_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_identity_snapshots_game_id ON identity_snapshots (game_id);
CREATE INDEX IF NOT EXISTS idx_endgames_game_id           ON endgames (game_id);
