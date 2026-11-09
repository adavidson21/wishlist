-- Hints: colors you'd rather not get, next to favorite colors on the profile ("Good to know").
-- colors_no: JSON array of color keys (FAV_COLORS in src/wishlist.js and public/index.html). NULL = not set.
-- Favorite colors (members.colors) are no longer capped at 3; same column, same keys.
ALTER TABLE members ADD COLUMN colors_no TEXT;
