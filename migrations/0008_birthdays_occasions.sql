-- Wishlist: birthdays and occasions.
-- Each person can add a birthday (month and day, year optional). Purchased marks and budgets now belong
-- to an occasion instead of a calendar year: Christmas for everyone, plus each person's birthday.
-- The `season` columns now hold the occasion's date as YYYYMMDD (Christmas 2026 = 20261225, a
-- March 5 birthday in 2027 = 20270305). A mark or budget counts until the day after that date.
ALTER TABLE members ADD COLUMN birth_month INTEGER;
ALTER TABLE members ADD COLUMN birth_day INTEGER;
ALTER TABLE members ADD COLUMN birth_year INTEGER;

-- Old seasons were calendar years, which all meant "this Christmas".
UPDATE claims SET season = season * 10000 + 1225 WHERE season < 10000;
UPDATE idea_claims SET season = season * 10000 + 1225 WHERE season < 10000;
UPDATE budgets SET season = season * 10000 + 1225 WHERE season < 10000;

CREATE INDEX IF NOT EXISTS claims_item_season ON claims(item_id, season);
CREATE INDEX IF NOT EXISTS budgets_subject ON budgets(subject_id, season);
