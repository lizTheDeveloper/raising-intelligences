-- Tag messages with the event they belong to so parentMessageCount can be
-- reconstructed correctly on reconnect without counting messages from earlier
-- events. Existing rows default to 0 (unknown event) — they won't match any
-- real currentEventNumber and so won't inflate the count.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS event_number INTEGER NOT NULL DEFAULT 0;

-- Persist sidebarUsed flags so a parent who used their private conversation
-- before disconnecting cannot claim a second sidebar after reconnecting.
ALTER TABLE games ADD COLUMN IF NOT EXISTS sidebar_used_parent1 BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE games ADD COLUMN IF NOT EXISTS sidebar_used_parent2 BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_messages_game_event ON messages (game_id, event_number);
