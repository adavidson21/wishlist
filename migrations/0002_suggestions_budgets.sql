-- Wishlist V1: shareable suggestions, price paid, and budgets.

-- A private idea can be shared as a suggestion: everyone in the family except the person it's for can see it.
ALTER TABLE private_ideas ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;

-- What you actually paid when marking a list item purchased (NULL = use the item's listed price).
ALTER TABLE claims ADD COLUMN price_cents INTEGER;

-- "Purchased" marks on ideas and suggestions, per season like item claims.
-- Replaces private_ideas.status, which is no longer used.
CREATE TABLE idea_claims (
  idea_id     TEXT NOT NULL REFERENCES private_ideas(id),
  season      INTEGER NOT NULL,
  buyer_id    TEXT NOT NULL REFERENCES members(id),
  price_cents INTEGER,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (idea_id, season)
);
CREATE INDEX idea_claims_buyer ON idea_claims(buyer_id, season);
CREATE INDEX claims_buyer ON claims(buyer_id, season);
CREATE INDEX private_ideas_subject ON private_ideas(subject_id);

INSERT INTO idea_claims (idea_id, season, buyer_id, price_cents, created_at)
  SELECT id, CAST(substr(updated_at, 1, 4) AS INTEGER), author_id, price_cents, updated_at
    FROM private_ideas WHERE status = 'bought';

-- Your own budget for each person, per season. Only ever returned to its author.
CREATE TABLE budgets (
  author_id    TEXT NOT NULL REFERENCES members(id),
  subject_id   TEXT NOT NULL REFERENCES members(id),
  season       INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  PRIMARY KEY (author_id, subject_id, season)
);
