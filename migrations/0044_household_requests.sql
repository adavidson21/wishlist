-- Household budgets plan (Nov 2026): joining a household shows you its shared budgets and purchases, and shows
-- it yours, so someone who uses Hints is asked first. Adding them makes a request here; they join when they say
-- yes (POST household/answer). People who don't use the app are still added directly. Households that existed
-- before this are untouched.
-- household_id NULL: "start a household with invited_by" (they had none when they asked).
CREATE TABLE household_requests (
  id           TEXT PRIMARY KEY,
  member_id    TEXT NOT NULL REFERENCES members(id),   -- who's asked
  household_id TEXT REFERENCES households(id),         -- the household they'd join
  invited_by   TEXT NOT NULL REFERENCES members(id),
  created_at   TEXT NOT NULL
);
CREATE INDEX household_requests_member ON household_requests(member_id);
CREATE INDEX household_requests_household ON household_requests(household_id);
CREATE UNIQUE INDEX household_requests_once ON household_requests(member_id, COALESCE(household_id, 'new:' || invited_by));
