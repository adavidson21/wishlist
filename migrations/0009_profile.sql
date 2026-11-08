-- Wishlist: profile details family can see on your list. Birthday is "MM-DD" (no year).
-- sizes is JSON: {"shirt","pants","shoe","ring"}, each free text. avoid is "Please no" free text.
ALTER TABLE members ADD COLUMN birthday TEXT;
ALTER TABLE members ADD COLUMN sizes TEXT;
ALTER TABLE members ADD COLUMN avoid TEXT;
