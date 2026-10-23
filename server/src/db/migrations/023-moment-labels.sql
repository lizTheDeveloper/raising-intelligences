-- Research labels comparing what a parent hoped (or said in a repair) with what
-- the child kept (the memory keeper's summary). One row per
-- (game, scene, kind); a re-label overwrites. Stored for later analysis only:
-- never returned to players, never fed into prompts. Rows are deleted with the
-- game (ON DELETE CASCADE) and explicitly in PgGameRepository.deleteGameData.
CREATE TABLE IF NOT EXISTS moment_labels (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id      UUID   NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  scene_index  INT    NOT NULL,
  kind         TEXT   NOT NULL,
  label        TEXT   NOT NULL,
  rationale    TEXT   NOT NULL DEFAULT '',
  labeled_at   BIGINT NOT NULL,
  UNIQUE (game_id, scene_index, kind)
);
CREATE INDEX IF NOT EXISTS idx_moment_labels_game_id ON moment_labels (game_id);
COMMENT ON TABLE moment_labels IS 'Research labels: did the child keep what the parent hoped / did a repair change it. Adult solo games only; keyed to a game and deleted with it. Never shown to players.';
