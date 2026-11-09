-- Hints: budgets shared by a household. When you're in a household and the person you're shopping for isn't
-- in it, everyone in your household shares one budget for them and sees what any of you bought for them.
-- At Christmas the budget covers their whole household (target 'h:<householdId>'); birthdays stay per person
-- (target 'm:<memberId>'), as does Christmas for someone with no household. Budgets for people in your own
-- household, and budgets set by someone with no household, stay personal in `budgets`.
CREATE TABLE household_budgets (
  household_id TEXT NOT NULL REFERENCES households(id),  -- the givers
  target       TEXT NOT NULL,                            -- 'h:<householdId>' or 'm:<memberId>'
  season       INTEGER NOT NULL,                         -- occasion date YYYYMMDD, like budgets.season
  amount_cents INTEGER NOT NULL,
  updated_by   TEXT,
  updated_at   TEXT,
  PRIMARY KEY (household_id, target, season)
);

-- Move existing budgets set across households. When two people in a household both set one for the same
-- person, the higher one wins. At Christmas, the people of one household add up into one household budget.
INSERT INTO household_budgets (household_id, target, season, amount_cents)
SELECT giver_hh, target, season, SUM(amount) FROM (
  SELECT a.household_id AS giver_hh,
         CASE WHEN b.season % 10000 = 1225 AND s.household_id IS NOT NULL THEN 'h:' || s.household_id ELSE 'm:' || s.id END AS target,
         b.season AS season,
         MAX(b.amount_cents) AS amount
    FROM budgets b
    JOIN members a ON a.id = b.author_id
    JOIN members s ON s.id = b.subject_id
   WHERE a.household_id IS NOT NULL AND (s.household_id IS NULL OR s.household_id != a.household_id)
   GROUP BY a.household_id, b.subject_id, b.season
)
GROUP BY giver_hh, target, season;

DELETE FROM budgets WHERE EXISTS (
  SELECT 1 FROM members a JOIN members s ON s.id = budgets.subject_id
   WHERE a.id = budgets.author_id AND a.household_id IS NOT NULL AND (s.household_id IS NULL OR s.household_id != a.household_id)
);
