-- Linked wishes ("Goes with"). bundle_id: wishes sharing one are all or nothing (coloring book and pencils).
-- needs_id: this wish is only wanted along with that one (one way). An item has at most one of the two.
ALTER TABLE items ADD COLUMN bundle_id TEXT;
ALTER TABLE items ADD COLUMN needs_id TEXT;
CREATE INDEX items_bundle ON items(bundle_id) WHERE bundle_id IS NOT NULL;
