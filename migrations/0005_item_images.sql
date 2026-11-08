-- Wishlist: a product photo for list items and ideas, read from the item's link.
-- image_url: the store's own image (hotlinked, never copied). image_checked_at: when we last looked,
-- so a link with no usable image is only fetched once (until the link changes).
ALTER TABLE items ADD COLUMN image_url TEXT;
ALTER TABLE items ADD COLUMN image_checked_at TEXT;
ALTER TABLE private_ideas ADD COLUMN image_url TEXT;
ALTER TABLE private_ideas ADD COLUMN image_checked_at TEXT;
