-- Hints: one row per link lookup (Fill, the Share button, the background details refresh, photo lookups, the daily
-- autofill check), so a store breaking shows up as numbers instead of going unnoticed. docs/plans/autofill-hardening.md
-- step 1. Only the store's host and what came back: no person, no link, no product name. Kept 60 days.
--   kind:   fill | share | refresh | photo | canary (daily check) | check (scripts/fill-check.mjs)
--   source: what named it: page | shopify | ai-page (Gemini opened the page) | search (Gemini, Google Search only)
--           | guess (words from the link) | cache | none
--   page:   what reading the page itself gave: ok (a name) | noname (loaded, no name) | blocked (bot check or
--           403/429/503) | timeout (no answer) | gone (404/410) | error (any other failure) | skipped (cache)
CREATE TABLE fill_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  host TEXT NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  page TEXT NOT NULL,
  http INTEGER,
  name INTEGER NOT NULL DEFAULT 0,
  photo INTEGER NOT NULL DEFAULT 0,
  price INTEGER NOT NULL DEFAULT 0,
  ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX fill_log_at ON fill_log (at);
CREATE INDEX fill_log_kind_host ON fill_log (kind, host, at);
