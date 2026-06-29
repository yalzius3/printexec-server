-- Spool split: divide one idle spool into N child spools.
--
-- A child spool points at its origin via parent_asset_id. The parent is marked
-- distributed with split_at and becomes unusable for new assignments (it's
-- excluded from the spool picker), but is otherwise maintained as-is.
--
-- Costing rule: children are EXCLUDED from material price-per-gram averaging —
-- the original parent (which retains its purchase_price + initial_grams) remains
-- the spool that counts, so a split never changes a material's average cost.
-- Both additive and nullable, so existing rows are unaffected.
ALTER TABLE asset_instances
  ADD COLUMN IF NOT EXISTS parent_asset_id uuid REFERENCES asset_instances(asset_id),
  ADD COLUMN IF NOT EXISTS split_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_asset_instances_parent_asset_id
  ON asset_instances(parent_asset_id);
