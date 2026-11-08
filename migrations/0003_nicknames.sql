-- Wishlist: your own name for someone ("Grandma" instead of "Jane Doe").
-- Private to its author: only ever returned to the person who set it.
CREATE TABLE nicknames (
  author_id  TEXT NOT NULL REFERENCES members(id),
  subject_id TEXT NOT NULL REFERENCES members(id),
  nickname   TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (author_id, subject_id)
);
