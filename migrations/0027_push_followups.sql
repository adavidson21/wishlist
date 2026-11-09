-- Hints: notification follow-ups.
-- Each push subscription belongs to the signed-in device (devices.token) that turned it on. A subscription whose
-- device is gone (signed out, bumped by the device cap, person removed) gets nothing and is deleted, so the next
-- person to use that phone never sees the last person's notifications. Old rows have no token and stay quiet until
-- the app re-registers them on its next start.
ALTER TABLE push_subs ADD COLUMN device_token TEXT;
CREATE INDEX push_subs_device ON push_subs(device_token);

-- Notifications that came up during quiet hours (9 pm to 8 am New York), sent at 8 am. One per person per tag,
-- so a newer one replaces an older one ("3 messages in the chat" not three pings).
CREATE TABLE push_later (
  member_id  TEXT NOT NULL REFERENCES members(id),
  tag        TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (member_id, tag)
);

-- The "2 new" badge on the Circles tab, per viewer and person: how many wishes their list had when you last opened
-- it. Kept on the server so it's the same on every device (it used to be per device in localStorage).
CREATE TABLE list_seen (
  viewer_id  TEXT NOT NULL REFERENCES members(id),
  owner_id   TEXT NOT NULL REFERENCES members(id),
  seen_count INTEGER NOT NULL,
  seen_at    TEXT NOT NULL,
  PRIMARY KEY (viewer_id, owner_id)
);

-- "Looks good" on the yearly "Your list hasn't changed since last year" card: the year it was tapped. Also stops
-- the Nov 15 reminder notification for that year.
ALTER TABLE members ADD COLUMN stale_ok_year INTEGER;
