-- Problems the app ran into and notes people send the person who runs Hints (Settings > Questions or problems).
-- kind: 'error' (from the app or the API, repeats of the same one bump count) or 'note' (written by someone).
-- sig: what makes two errors "the same" (a note's sig is its own id). done_at: the owner marked it handled.
CREATE TABLE reports (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  member_id  TEXT,
  body       TEXT NOT NULL,
  detail     TEXT,
  sig        TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_at    TEXT NOT NULL,
  done_at    TEXT
);
CREATE UNIQUE INDEX reports_sig ON reports(sig);
CREATE INDEX reports_last ON reports(last_at);
