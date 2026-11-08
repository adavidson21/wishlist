-- Wishlist: gift cards and favorite brands.

-- Gift card brands someone would like (keys from public/giftcards.js). Not tied to a season: they stay on
-- the list year after year, and they're never "taken", any number of people can give one.
CREATE TABLE gift_cards (
  member_id  TEXT NOT NULL REFERENCES members(id),
  brand      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (member_id, brand)
);

-- "I'm giving one": one row per giver per brand per occasion. season is the occasion's date as YYYYMMDD
-- (Christmas or their birthday, like claims.season, migration 0011); a gift counts through that day.
-- Never returned to the person it's for. amount_cents is optional, like the price paid on a list item.
CREATE TABLE gift_card_gifts (
  member_id    TEXT NOT NULL REFERENCES members(id),
  brand        TEXT NOT NULL,
  season       INTEGER NOT NULL,
  buyer_id     TEXT NOT NULL REFERENCES members(id),
  amount_cents INTEGER,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (member_id, brand, season, buyer_id)
);
CREATE INDEX gift_card_gifts_buyer ON gift_card_gifts(buyer_id, season);

-- Favorite brands on your profile: a JSON array of names (free text). Shown to family in "Good to know".
ALTER TABLE members ADD COLUMN brands TEXT;

-- Gift cards are their own thing now, not a wish category.
UPDATE items SET category = NULL WHERE category = 'giftcards';
