-- Hints: jewelry metal preference on the profile ("Good to know").
-- metals: JSON array of metal keys (METALS in src/wishlist.js and public/index.html). NULL = not set.
-- mixed_metals: 1 when the person is happy with mixed metals.
ALTER TABLE members ADD COLUMN metals TEXT;
ALTER TABLE members ADD COLUMN mixed_metals INTEGER NOT NULL DEFAULT 0;
