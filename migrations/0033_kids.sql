-- Hints: things that help when shopping for kids.
-- is_kid: set by whoever looks after them (no ages are stored, see 0032_no_birth_year): Kid chip, Kids filter
-- on Circles, and size reminders.
-- sizes_at: when someone's sizes last changed, so the app can say "Updated 5 months ago" (kids outgrow sizes fast).
-- NULL for sizes saved before this migration (unknown).
-- owns: "Already has" tags (JSON array, like likes/dislikes), so people don't buy a second of the same toy.
ALTER TABLE members ADD COLUMN is_kid INTEGER NOT NULL DEFAULT 0;
ALTER TABLE members ADD COLUMN sizes_at TEXT;
ALTER TABLE members ADD COLUMN owns TEXT;
