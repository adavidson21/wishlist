-- Wishlist: people you're not doing gifts with. Personal (only ever returned to its author): someone in your circle
-- you've agreed not to exchange gifts with is left out of your budget totals, "still need a gift for", and the
-- birthday and Christmas reminders. target is 'm:<memberId>' for one person or 'h:<householdId>' for a whole
-- household (which also covers anyone who joins that household later).
CREATE TABLE budget_skips (
  author_id  TEXT NOT NULL REFERENCES members(id),
  target     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (author_id, target)
);
