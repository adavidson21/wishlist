-- Wishlist: a category per wish (picked by the owner; NULL = guessed from the title in the app),
-- and a one-time price lookup from the item's link for wishes saved without a price.
-- price_checked_at: when we last looked, so a link with no readable price is only fetched once (until the link changes).
ALTER TABLE items ADD COLUMN category TEXT;
ALTER TABLE items ADD COLUMN price_checked_at TEXT;
ALTER TABLE private_ideas ADD COLUMN price_checked_at TEXT;
