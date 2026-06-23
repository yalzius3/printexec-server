-- Printer markers: an optional, freeform short label (e.g. "A2", "Left") used to
-- physically distinguish otherwise-identical printers, mirroring the existing
-- spool marker on asset_instances. Additive and nullable, so it has no effect on
-- existing rows.
ALTER TABLE printer_instances
  ADD COLUMN IF NOT EXISTS marker text;
