-- Hints: group gifts and wishes you want more than one of.
-- items.quantity: how many the owner wants (default 1; 0 = as many as you like).
-- claims is rebuilt so a wish can have several buyers per occasion: the key is now (item_id, season, buyer_id).
--   qty: how many you're getting. chip_in = 1: your row is a share of the wish's group gift (counts as one, together).
-- Existing marks copy over as one solo buyer each.
PRAGMA defer_foreign_keys = on;

ALTER TABLE items ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1;

CREATE TABLE claims_new (
  item_id     TEXT NOT NULL REFERENCES items(id),
  season      INTEGER NOT NULL,
  buyer_id    TEXT NOT NULL REFERENCES members(id),
  created_at  TEXT NOT NULL,
  price_cents INTEGER,
  status      TEXT,
  stash       TEXT,
  qty         INTEGER NOT NULL DEFAULT 1,
  chip_in     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, season, buyer_id)
);
INSERT INTO claims_new (item_id, season, buyer_id, created_at, price_cents, status, stash)
  SELECT item_id, season, buyer_id, created_at, price_cents, status, stash FROM claims;
DROP TABLE claims;
ALTER TABLE claims_new RENAME TO claims;
CREATE INDEX claims_buyer ON claims(buyer_id, season);
CREATE INDEX claims_item_season ON claims(item_id, season);
