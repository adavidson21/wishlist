-- Wishlist: a few fun profile extras family sees on your list ("Good to know").
-- gift_style: JSON array of up to 3 keys (GIFT_STYLES in src/wishlist.js and public/index.html).
-- colors: JSON array of up to 3 color keys (FAV_COLORS, same two places). loves: short free text.
ALTER TABLE members ADD COLUMN gift_style TEXT;
ALTER TABLE members ADD COLUMN colors TEXT;
ALTER TABLE members ADD COLUMN loves TEXT;
