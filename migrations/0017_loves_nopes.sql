-- Hints: loves and nopes on your profile, plus a one-line bio.
-- likes, dislikes: JSON arrays of short free-text tags ("cats", "fuzzy socks"). bio: short free text.
-- The old free-text `loves` stays until someone saves their profile: the API turns it into likes on read
-- (split on commas) and clears it the first time likes are saved. `avoid` stays as "Allergies and hard nos".
ALTER TABLE members ADD COLUMN likes TEXT;
ALTER TABLE members ADD COLUMN dislikes TEXT;
ALTER TABLE members ADD COLUMN bio TEXT;
