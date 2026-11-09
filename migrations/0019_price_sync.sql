-- Wishlist: prices that came from the item's link stay in sync with the store.
-- price_auto: 1 = the price was filled in from the link (Fill, a photo match, or the background lookup) and
-- the owner hasn't typed over it, so live price checks keep it current. 0 = typed by hand, never touched.
ALTER TABLE items ADD COLUMN price_auto INTEGER NOT NULL DEFAULT 0;
ALTER TABLE private_ideas ADD COLUMN price_auto INTEGER NOT NULL DEFAULT 0;
