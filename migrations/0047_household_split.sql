-- Household budgets plan (Nov 2026): per-person split for Christmas household budgets, and gifts for several
-- people in one household.
-- split = 1: the household's Christmas budget for another household is divided per person
-- (household_budget_people); amount_cents is then kept equal to their sum.
ALTER TABLE household_budgets ADD COLUMN split INTEGER NOT NULL DEFAULT 0;
CREATE TABLE household_budget_people (
  household_id TEXT NOT NULL REFERENCES households(id),   -- the givers
  target       TEXT NOT NULL,                             -- 'h:<householdId>' (always a household)
  season       INTEGER NOT NULL,
  member_id    TEXT NOT NULL REFERENCES members(id),      -- one person in that household
  amount_cents INTEGER NOT NULL,
  updated_by   TEXT,
  updated_at   TEXT,
  PRIMARY KEY (household_id, target, season, member_id)
);
CREATE INDEX household_budget_people_member ON household_budget_people(member_id);
-- A gift idea or purchase for more than one person in a household: the others it's for (JSON array of member
-- ids; subject_id is the first). Its price counts evenly against each of them.
ALTER TABLE private_ideas ADD COLUMN also_for TEXT;
