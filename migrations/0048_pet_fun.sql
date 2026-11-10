-- Hints: pet birthdays and favorites, just for fun. Still not people: no list, budget, occasion or reminders.
-- birthday: "MM-DD" (no year, like people: Hints never shows ages). favorites: one short line, shown as chips
-- split on commas ("squeaky ducks, peanut butter, belly rubs").
ALTER TABLE pets ADD COLUMN birthday TEXT;
ALTER TABLE pets ADD COLUMN favorites TEXT;
