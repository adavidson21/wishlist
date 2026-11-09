-- Hints: an optional cover photo on a person's profile card, set the same way as their profile photo.
-- cover: a wide (3:1) JPEG as a data URL, cropped in the browser. Without one, the cover is painted in their favorite colors.
-- cover_at: when it was last changed. Sent to the app as the cover's version so browsers can cache it.
ALTER TABLE members ADD COLUMN cover TEXT;
ALTER TABLE members ADD COLUMN cover_at TEXT;
