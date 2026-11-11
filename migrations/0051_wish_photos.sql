-- Your own photo for a wish (Add a photo on Drop a hint and Edit wish), for stores we can't read or things with no link.
-- Kept out of items so list reads stay small. While a wish has one, items.image_url points at GET photo?i=<item id>,
-- and it wins over the store's photo.
CREATE TABLE item_photos (
  item_id    TEXT PRIMARY KEY,
  photo      TEXT NOT NULL,   -- JPEG data URL from the app
  v          TEXT NOT NULL,   -- version for the photo URL, changes with each new photo
  updated_at TEXT NOT NULL
);
