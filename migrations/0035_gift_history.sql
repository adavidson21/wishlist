-- Hints: gift history. Once an occasion passes, each purchase (a wish, an idea or suggestion, a gift card) is
-- copied here as a snapshot (title, link, photo, spent), so it survives later edits and deletes.
-- src/wishlist.js snapshotGifts() fills it hourly and before a wish or idea is deleted. kind: item, idea, card.
-- ref_id: the wish or idea id, or the gift card's brand key.
CREATE TABLE gift_history (
  buyer_id    TEXT NOT NULL REFERENCES members(id),
  subject_id  TEXT NOT NULL REFERENCES members(id),
  season      INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  ref_id      TEXT NOT NULL,
  title       TEXT NOT NULL,
  url         TEXT,
  image_url   TEXT,
  spent_cents INTEGER NOT NULL DEFAULT 0,
  qty         INTEGER NOT NULL DEFAULT 1,
  chip_in     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (buyer_id, kind, ref_id, season)
);
CREATE INDEX gift_history_buyer ON gift_history(buyer_id, season);
CREATE INDEX gift_history_subject ON gift_history(subject_id, season);
