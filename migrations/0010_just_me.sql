-- Wishlist: the "Just me" section. New wishes start private to their owner (draft = 1)
-- and are published to the real wish list (draft = 0) with a one-way Publish action.
-- Existing items stay published.
ALTER TABLE items ADD COLUMN draft INTEGER NOT NULL DEFAULT 0;
CREATE INDEX items_owner_draft ON items(owner_id, draft);
