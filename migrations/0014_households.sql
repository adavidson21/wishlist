-- Wishlist: households. Three layers: people, optional households, and circles (the `groups` table,
-- shown as "Circles" in the app; it used to say "family").
-- A person is in at most one household (members.household_id). A circle can include whole households
-- (group_households) as well as individual people. Everyone in a household that's in a circle is in that
-- circle, including people who join the household later.
--
-- group_members stays the one place the API checks for "shares a circle", so households are synced into it:
-- direct = 1 means the person joined the circle themselves; direct = 0 means they're only there through
-- their household and drop out when they leave it (or the household is taken out of the circle).
CREATE TABLE households (
  id         TEXT PRIMARY KEY,
  name       TEXT,               -- NULL = named from its people ("Alexis & Sam")
  created_at TEXT NOT NULL
);

ALTER TABLE members ADD COLUMN household_id TEXT REFERENCES households(id);
CREATE INDEX members_household ON members(household_id);

CREATE TABLE group_households (
  group_id     TEXT NOT NULL REFERENCES groups(id),
  household_id TEXT NOT NULL REFERENCES households(id),
  added_at     TEXT NOT NULL,
  PRIMARY KEY (group_id, household_id)
);
CREATE INDEX group_households_household ON group_households(household_id);

ALTER TABLE group_members ADD COLUMN direct INTEGER NOT NULL DEFAULT 1;
