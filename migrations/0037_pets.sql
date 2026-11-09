-- Hints: pets. Not people (no list, no login, no birthday): just info for gift-givers.
-- A pet belongs to a household, or to a person who isn't in one (never both). Someone joining a household brings
-- their pets into it; when the last person leaves a household, its pets go with them.
-- Seen by anyone who shares a circle with someone in that household (or with that person).
CREATE TABLE pets (
  id           TEXT PRIMARY KEY,
  household_id TEXT REFERENCES households(id),
  member_id    TEXT REFERENCES members(id),
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL,      -- dog, cat, bird, fish, bunny, reptile, horse, other (PET_KINDS in src/wishlist.js)
  notes        TEXT,               -- one short line: "size L harness, destroys plush toys"
  photo        TEXT,               -- data URL, served by GET photo?p=
  photo_at     TEXT,
  created_at   TEXT NOT NULL,
  CHECK ((household_id IS NULL) <> (member_id IS NULL))
);
CREATE INDEX pets_household ON pets(household_id);
CREATE INDEX pets_member ON pets(member_id);
