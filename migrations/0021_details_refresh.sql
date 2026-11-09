-- Hints: one-time refresh of link details for wishes and ideas saved before the newer fields existed
-- (photo, price with store sync, brand, size, color). details_v = which refresh a row has had (src/wishlist.js
-- DETAILS_V). Existing rows start at 0 and get refreshed in the background; new and edited rows are stamped current.
ALTER TABLE items ADD COLUMN details_v INTEGER NOT NULL DEFAULT 0;
ALTER TABLE private_ideas ADD COLUMN details_v INTEGER NOT NULL DEFAULT 0;
