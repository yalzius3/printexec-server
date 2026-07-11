-- Nozzle identity fields: an optional free-text display name ("call a nozzle
-- whatever you want") and an optional brand, mirroring how spools/printers
-- carry richer identity. Nozzle price needs NO new column — asset_instances
-- already has purchase_price (spools write it); nozzles now write it too.
-- Both columns are additive and nullable, so existing rows are unaffected.
ALTER TABLE asset_instances
  ADD COLUMN IF NOT EXISTS nozzle_name text;

ALTER TABLE asset_instances
  ADD COLUMN IF NOT EXISTS nozzle_brand text;
