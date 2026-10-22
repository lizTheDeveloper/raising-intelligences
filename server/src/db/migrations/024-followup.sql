-- Optional follow-up contact (adult research players only; routes/research.ts).
--
-- Two tables on purpose, so an email is never stored in a table that also holds
-- game answers or carries a game_id:
--   followup_links    game_id -> pseudonym_id. The pseudonym is random
--                     (crypto.randomUUID in the repository) and has no
--                     relationship to the game id. One row per game.
--   followup_contacts pseudonym_id -> email and the two separate consents.
--                     No game_id column.
--
-- Deletion: followup_contacts.pseudonym_id references followup_links with
-- ON DELETE CASCADE, and followup_links.game_id references games with
-- ON DELETE CASCADE, so deleting a game removes the email by cascade.
-- PgGameRepository.deleteGameData also deletes both rows explicitly (looking
-- the pseudonym up first) inside its transaction.
--
-- Withdrawal does not delete the row: it sets email to NULL, both consents to
-- false and records withdrawn_at, so that "withdrew" stays distinguishable from
-- "never asked". A later consent re-opens the row (withdrawn_at back to NULL).
-- Timestamps are epoch milliseconds, like question_answers.
CREATE TABLE IF NOT EXISTS followup_links (
  game_id       UUID PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
  pseudonym_id  UUID NOT NULL UNIQUE
);
COMMENT ON TABLE followup_links IS 'Maps a game to a random follow-up pseudonym. Holds no email. Deleted with the game.';

CREATE TABLE IF NOT EXISTS followup_contacts (
  pseudonym_id          UUID PRIMARY KEY REFERENCES followup_links(pseudonym_id) ON DELETE CASCADE,
  email                 TEXT,
  consent_followup      BOOLEAN NOT NULL DEFAULT false,
  consent_ai_analysis   BOOLEAN NOT NULL DEFAULT false,
  consented_at          BIGINT,
  withdrawn_at          BIGINT
);
COMMENT ON TABLE followup_contacts IS 'Opt-in follow-up email and the two separate consents (contact; AI-written and AI-analyzed follow-ups). Email is NULL once withdrawn. No game_id by design.';
