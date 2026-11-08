-- Wishlist: one person in several families, with per-family hiding of list items.
-- Membership was already many-to-many (group_members); this adds the hiding.

-- An item hidden from a family is not shown to anyone through that family.
-- Someone who shares another family with the owner (where it isn't hidden) still sees it.
CREATE TABLE item_hidden (
  item_id  TEXT NOT NULL REFERENCES items(id),
  group_id TEXT NOT NULL REFERENCES groups(id),
  PRIMARY KEY (item_id, group_id)
);
CREATE INDEX item_hidden_group ON item_hidden(group_id);
