-- Hints: a category guessed by Gemini from the wish's name, brand and store (never anything about the person).
-- Kept apart from items.category (the owner's own pick), so "Auto" in the wish form still means auto.
-- NULL = not guessed yet (new wish, or the name changed). Filled right after a save and by the hourly run.
ALTER TABLE items ADD COLUMN category_auto TEXT;
