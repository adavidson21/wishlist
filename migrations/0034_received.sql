-- Hints: received wishes. After an occasion passes, a wish someone marked for it is held (off everyone's
-- shopping view) until its owner says "Got it" (received) or "Still want it" (settled, back on the list).
-- Held wishes nobody answers about are received 30 days after the occasion (src/wishlist.js settleReceived).
ALTER TABLE items ADD COLUMN held_season INTEGER;
ALTER TABLE items ADD COLUMN settled_season INTEGER;
ALTER TABLE items ADD COLUMN received_at TEXT;
ALTER TABLE items ADD COLUMN received_season INTEGER;
ALTER TABLE items ADD COLUMN thanked_at TEXT;
CREATE INDEX items_held ON items(owner_id, held_season);
