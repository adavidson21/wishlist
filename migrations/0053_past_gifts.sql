-- Hints: gift history from before the app, imported from your own spreadsheets (scripts/import-history.mjs).
-- Shown with gift_history in Budget > History, to the buyer and their household (same rule as gift_history).
-- Unlike gift_history, the person can be someone who isn't in the app: `person` is their name as written, and
-- member_id links them when they are. Each import replaces the rows of its `source`, so re-running is safe.

-- One row per person per occasion: the budget and what was spent in total.
CREATE TABLE past_totals (
  buyer_id     TEXT NOT NULL REFERENCES members(id),
  season       INTEGER NOT NULL,   -- occasion date YYYYMMDD like gift_history; MMDD 0000 = a birthday with no date
  person       TEXT NOT NULL,
  member_id    TEXT REFERENCES members(id),
  budget_cents INTEGER,
  spent_cents  INTEGER,
  note         TEXT,
  source       TEXT NOT NULL,
  PRIMARY KEY (buyer_id, season, person)
);

-- Each gift. price_cents is NULL when the spreadsheet didn't list one.
CREATE TABLE past_gifts (
  id          TEXT PRIMARY KEY,
  buyer_id    TEXT NOT NULL REFERENCES members(id),
  season      INTEGER NOT NULL,
  person      TEXT NOT NULL,
  member_id   TEXT REFERENCES members(id),
  title       TEXT NOT NULL,
  price_cents INTEGER,
  note        TEXT,
  pos         INTEGER NOT NULL DEFAULT 0,
  source      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX past_gifts_buyer ON past_gifts(buyer_id, season);
CREATE INDEX past_gifts_member ON past_gifts(member_id);
