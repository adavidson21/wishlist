-- Household budgets plan (Nov 2026): budgets now follow people when households change (budgetsOnJoin and
-- leaveHousehold in src/wishlist.js). Before that, some budgets could end up stored but never shown. This brings
-- them back. It only adds a shared budget where none is shown today, so no amount anyone sees goes down or changes.

-- 1. Someone joined a household after setting their own budgets for people outside it: those now count as the
--    household's (the higher one when two people in it set one for the same person, people of one household
--    added together at Christmas, as in migration 0029).
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
WHERE true
GROUP BY giver_hh, target, season
ON CONFLICT (household_id, target, season) DO NOTHING;

-- 2. A Christmas budget set for someone on their own, who has since joined a household: it's that household's
--    now (several people of one household add together), unless the household already has one.
INSERT INTO household_budgets (household_id, target, season, amount_cents, updated_by, updated_at)
SELECT hb.household_id, 'h:' || m.household_id, hb.season, SUM(hb.amount_cents), MAX(hb.updated_by), MAX(hb.updated_at)
  FROM household_budgets hb JOIN members m ON hb.target = 'm:' || m.id
 WHERE hb.season % 10000 = 1225 AND m.household_id IS NOT NULL AND m.household_id != hb.household_id
 GROUP BY hb.household_id, m.household_id, hb.season
ON CONFLICT (household_id, target, season) DO NOTHING;
