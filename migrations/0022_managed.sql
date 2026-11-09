-- Hints: people someone looks after (a kid, a grandparent who doesn't use the app). managed_by = the member who
-- added them; NULL = signs in normally. Managers: that person plus anyone in the same household (src/wishlist.js canManage).
ALTER TABLE members ADD COLUMN managed_by TEXT;
