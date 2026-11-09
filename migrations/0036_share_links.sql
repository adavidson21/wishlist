-- Hints: a read-only link to someone's list for people outside their circles (/s/TOKEN, src/wishlist.js sharePage).
-- NULL = off. A new link replaces the old one.
ALTER TABLE members ADD COLUMN share_token TEXT;
CREATE UNIQUE INDEX members_share_token ON members(share_token);
