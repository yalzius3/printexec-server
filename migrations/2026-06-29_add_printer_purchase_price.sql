-- Printer purchase price ("price at purchase"): the amount paid for this
-- physical printer when it was acquired. Mirrors asset_instances.purchase_price
-- on spools so the assets workspace can show a per-printer Price column and a
-- page-total value sum. Additive and nullable, so existing rows are unaffected.
ALTER TABLE printer_instances
  ADD COLUMN IF NOT EXISTS purchase_price numeric;

ALTER TABLE printer_instances
  ADD CONSTRAINT chk_printer_purchase_price_nonneg
  CHECK (purchase_price IS NULL OR purchase_price >= 0)
  NOT VALID;
