-- Wishlist: an optional profile photo per person, set by that person in Settings.
-- photo: a small square JPEG as a data URL (resized in the browser, about 10 KB).
-- photo_at: when it was last changed. Sent to the app as the photo's version so browsers can cache it.
ALTER TABLE members ADD COLUMN photo TEXT;
ALTER TABLE members ADD COLUMN photo_at TEXT;
