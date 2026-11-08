-- Wishlist: first-run welcome tour. Set once a person finishes (or skips) the tour, so it shows
-- once per person, not once per device. People who joined before the tour existed count as done
-- (they can replay it from Settings).
ALTER TABLE members ADD COLUMN onboarded_at TEXT;
UPDATE members SET onboarded_at = created_at;
