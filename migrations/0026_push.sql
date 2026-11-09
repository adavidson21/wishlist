-- Hints: push notifications (src/push.js). One row per device that turned them on.
CREATE TABLE push_subs (
  endpoint   TEXT PRIMARY KEY,
  member_id  TEXT NOT NULL REFERENCES members(id),
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX push_subs_member ON push_subs(member_id);
-- App-wide values: the VAPID key pair ('vapid', made on first use) and the new-wish digest's cursor ('wishes_cursor').
CREATE TABLE app_keys (name TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Reminders already sent, so a retried run never sends one twice.
CREATE TABLE push_sent (key TEXT PRIMARY KEY, sent_at TEXT NOT NULL);
-- Which notifications someone wants: JSON { wishes, birthdays, groupGifts }. NULL = all on.
ALTER TABLE members ADD COLUMN notify TEXT;
