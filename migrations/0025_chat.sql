-- Hints: hidden chat about a person, one thread per circle (group_id, subject_id). Everyone in the circle can
-- read and write it except the person it's about, who never gets anything from it (not even a count).
-- A message can be tagged to one of their wishes (item_id) or a shared suggestion (idea_id).
-- Messages older than 6 months are swept by the app (CHAT_KEEP_DAYS in src/wishlist.js).
CREATE TABLE chat_messages (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL REFERENCES groups(id),
  subject_id  TEXT NOT NULL REFERENCES members(id),
  author_id   TEXT NOT NULL REFERENCES members(id),
  item_id     TEXT, -- no foreign key: wishes and ideas can be hard deleted; the tag then shows as removed
  idea_id     TEXT,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  edited_at   TEXT,
  deleted_at  TEXT
);
CREATE INDEX chat_thread ON chat_messages(group_id, subject_id, created_at);
CREATE INDEX chat_created ON chat_messages(created_at);

-- Unread tracking: when each reader last opened each thread.
CREATE TABLE chat_reads (
  member_id    TEXT NOT NULL REFERENCES members(id),
  group_id     TEXT NOT NULL REFERENCES groups(id),
  subject_id   TEXT NOT NULL REFERENCES members(id),
  last_read_at TEXT NOT NULL,
  PRIMARY KEY (member_id, group_id, subject_id)
);
