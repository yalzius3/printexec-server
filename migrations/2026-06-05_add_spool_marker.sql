-- Spool markers: an optional, freeform short label (e.g. "A2", "1B") used to
-- physically distinguish otherwise-identical spools. Additive and nullable, so
-- it has no effect on existing rows. The column lives on asset_instances (shared
-- by every asset type) but is only surfaced for filament spools in the UI.
ALTER TABLE asset_instances
  ADD COLUMN IF NOT EXISTS marker text;
