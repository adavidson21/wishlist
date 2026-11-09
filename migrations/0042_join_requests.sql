-- Public hardening (Nov 2026).
-- Ask to join: when a circle's admin turns it on, new people (and people already on Hints joining with the code)
-- wait here until the admin lets them in or declines. They can't see the circle until then.
ALTER TABLE groups ADD COLUMN ask_to_join INTEGER NOT NULL DEFAULT 0;
CREATE TABLE join_requests (
  group_id   TEXT NOT NULL REFERENCES groups(id),
  member_id  TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, member_id)
);
CREATE INDEX join_requests_member ON join_requests(member_id);
