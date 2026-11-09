-- Wishlist: a rough price guess for wishes and ideas whose store price can't be read (Gemini, from the name and
-- brand). Shown as "~$40" and never counted in budgets. NULL = not guessed yet, -1 = tried and had no idea.
-- Cleared when the name or link changes so it's guessed again.
ALTER TABLE items ADD COLUMN price_est_cents INTEGER;
ALTER TABLE private_ideas ADD COLUMN price_est_cents INTEGER;
