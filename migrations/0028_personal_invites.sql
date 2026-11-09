-- Hints: personal invite links. Someone sets up a list for a person who isn't on Hints yet (members.managed_by),
-- then sends that person their own link (/join/CODE?hi=TOKEN). Opening it signs them in as themselves and hands
-- the list over, no PIN or name picking needed. Only a SHA-256 of the token is kept. One link per person at a
-- time: sending a new one replaces the old. Both columns go back to NULL once it's used or the list is handed over.
ALTER TABLE members ADD COLUMN claim_hash TEXT;
ALTER TABLE members ADD COLUMN claim_expires TEXT;
CREATE INDEX members_claim ON members(claim_hash);
