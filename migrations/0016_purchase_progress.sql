-- Wishlist: track gifts bought ahead of time. Each purchase (a list item claim, an idea claim, or a gift
-- card you're giving) gets a progress stage and where you've stashed it. Only ever returned to the buyer.
-- status: NULL = ordered / on the way, 'home' = you have it, 'wrapped', 'given'.
-- stash: free text, where it's hidden ("hall closet, top shelf").
ALTER TABLE claims ADD COLUMN status TEXT;
ALTER TABLE claims ADD COLUMN stash TEXT;
ALTER TABLE idea_claims ADD COLUMN status TEXT;
ALTER TABLE idea_claims ADD COLUMN stash TEXT;
ALTER TABLE gift_card_gifts ADD COLUMN status TEXT;
ALTER TABLE gift_card_gifts ADD COLUMN stash TEXT;
