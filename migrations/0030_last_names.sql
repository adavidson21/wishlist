-- Wishlist: last names. members.name stays the first name (what the app shows); last_name tells two people with
-- the same first name apart. Required for everyone added from now on. People from before this are NULL until they
-- (or whoever looks after them) add one; for matching, NULL counts as an empty last name.
ALTER TABLE members ADD COLUMN last_name TEXT;
