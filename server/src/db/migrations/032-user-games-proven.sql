-- Privacy review F1: a user_games row used to be written by anyone, for any
-- user id and any game id (POST /user/:userId/kids was unauthenticated), and
-- the album scrapbook read a game's epilogue and report card through it.
-- A row now grants reads (the scrapbook, and resuming a seatless game on
-- another device) only when it was written with proof of access: the game's
-- secret, a seat token, or by the server for a seat. Existing rows were never
-- proven and stay listing-only until their owner's device syncs again.
ALTER TABLE user_games ADD COLUMN IF NOT EXISTS proven BOOLEAN NOT NULL DEFAULT false;
