-- Wishlist: who started each circle (they can rename it and set its photo), and photos for circles and
-- households. Photos are small square JPEG data URLs like members.photo; photo_at is their version.
ALTER TABLE groups ADD COLUMN created_by TEXT REFERENCES members(id);
ALTER TABLE groups ADD COLUMN photo TEXT;
ALTER TABLE groups ADD COLUMN photo_at TEXT;
ALTER TABLE households ADD COLUMN photo TEXT;
ALTER TABLE households ADD COLUMN photo_at TEXT;

-- Circles made before this: the first person who joined is the one who started it.
UPDATE groups SET created_by = (
  SELECT gm.member_id FROM group_members gm WHERE gm.group_id = groups.id ORDER BY gm.joined_at, gm.rowid LIMIT 1
);
