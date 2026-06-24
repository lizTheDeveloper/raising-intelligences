-- Indexes to support admin dashboard queries.
CREATE INDEX IF NOT EXISTS idx_games_phase ON games (phase);
CREATE INDEX IF NOT EXISTS idx_games_updated_at ON games (updated_at);
