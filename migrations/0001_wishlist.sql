-- Wishlist MVP schema. Apply with:
--   npx wrangler d1 migrations apply wishlist --remote   (production)
--   npx wrangler d1 migrations apply wishlist --local    (wrangler dev)
-- Ids are random strings, money is in cents, times are ISO strings.

CREATE TABLE groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  join_code  TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE members (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  pin_hash   TEXT,               -- optional 4-digit PIN, hashed with the member id
  created_at TEXT NOT NULL
);

CREATE TABLE group_members (
  group_id  TEXT NOT NULL REFERENCES groups(id),
  member_id TEXT NOT NULL REFERENCES members(id),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (group_id, member_id)
);
CREATE INDEX group_members_member ON group_members(member_id);

-- One row per signed-in phone or browser. The token is the only credential.
CREATE TABLE devices (
  token      TEXT PRIMARY KEY,
  member_id  TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  last_seen  TEXT NOT NULL
);

-- Wish list items. One list per member, shown in every group they belong to.
CREATE TABLE items (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES members(id),
  title       TEXT NOT NULL,
  url         TEXT,
  price_cents INTEGER,
  notes       TEXT,
  priority    TEXT,             -- 'must' or NULL (nice to have)
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  removed_at  TEXT              -- set when the owner removes an item someone already bought
);
CREATE INDEX items_owner ON items(owner_id);

-- "Purchased" marks. Never returned to the item's owner. Season = year, so marks reset each Christmas.
CREATE TABLE claims (
  item_id    TEXT NOT NULL REFERENCES items(id),
  season     INTEGER NOT NULL,
  buyer_id   TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (item_id, season)
);

-- Private gift ideas and notes about another person. Only ever returned to the author.
CREATE TABLE private_ideas (
  id          TEXT PRIMARY KEY,
  author_id   TEXT NOT NULL REFERENCES members(id),
  subject_id  TEXT NOT NULL REFERENCES members(id),
  title       TEXT NOT NULL,
  url         TEXT,
  price_cents INTEGER,
  note        TEXT,
  status      TEXT NOT NULL DEFAULT 'idea',  -- 'idea' or 'bought'
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX private_ideas_author ON private_ideas(author_id, subject_id);
