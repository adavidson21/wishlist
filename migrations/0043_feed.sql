-- Hints: activity feed on the Circles tab (docs/plans/activity-feed.md).
-- feed: one card each. kind 'wishes' (meta {"items":[ids]}), 'profile' (meta {"fields":[...]}) or 'post'.
-- Who sees a card is worked out when the feed is read (shared circles, ITEM_VISIBLE for each wish), never stored.
CREATE TABLE feed (
  id         TEXT PRIMARY KEY,
  actor_id   TEXT NOT NULL REFERENCES members(id),
  kind       TEXT NOT NULL,
  group_id   TEXT,  -- a post sent to one circle; NULL = all the actor's circles
  body       TEXT,
  share_id   TEXT,  -- a post sharing another card (no foreign key: it may be removed)
  meta       TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  edited_at  TEXT,
  deleted_at TEXT
);
CREATE INDEX feed_actor ON feed(actor_id, kind, updated_at);
CREATE INDEX feed_updated ON feed(updated_at);

CREATE TABLE feed_comments (
  id         TEXT PRIMARY KEY,
  feed_id    TEXT NOT NULL,
  author_id  TEXT NOT NULL REFERENCES members(id),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX feed_comments_feed ON feed_comments(feed_id, created_at);

-- One reaction per person per card.
CREATE TABLE feed_reactions (
  feed_id    TEXT NOT NULL,
  member_id  TEXT NOT NULL REFERENCES members(id),
  emoji      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (feed_id, member_id)
);
