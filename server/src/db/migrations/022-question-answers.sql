-- Answers to the optional research questions shown during scene-generation
-- waits (adult players only; see routes/research.ts). One row per
-- (game, scene, question); a later answer overwrites an earlier one and a skip
-- never overwrites an answer. Rows are deleted with the game (ON DELETE
-- CASCADE) and explicitly in PgGameRepository.deleteGameData.
CREATE TABLE IF NOT EXISTS question_answers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id           UUID        NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  scene_index       INT         NOT NULL,
  question_id       TEXT        NOT NULL,
  question_version  INT         NOT NULL,
  kind              TEXT        NOT NULL,
  answer            JSONB,
  skipped           BOOLEAN     NOT NULL DEFAULT false,
  shown_at          BIGINT      NOT NULL,
  answered_at       BIGINT      NOT NULL,
  UNIQUE (game_id, scene_index, question_id)
);
CREATE INDEX IF NOT EXISTS idx_question_answers_game_id ON question_answers (game_id);
COMMENT ON TABLE question_answers IS 'Optional research question answers (adult players only). Keyed to a game; deleted with it.';
