-- ================================================================
-- 1. Rename companies.electricity_price_per_watt -> _per_kwh (it always
--    held the per-kWh price). 2. Add orders.labor_cost (operator-entered
--    labour cost for the whole order). Additive/idempotent, safe to re-run.
-- ================================================================

BEGIN;

-- ── Rename electricity column to reflect its real unit (per kWh) ──
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'companies'
      AND column_name = 'electricity_price_per_watt'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'companies'
      AND column_name = 'electricity_price_per_kwh'
  ) THEN
    ALTER TABLE public.companies
      RENAME COLUMN electricity_price_per_watt TO electricity_price_per_kwh;
  END IF;
END $$;

-- Ensure it exists even on a fresh DB that never had the old name.
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS electricity_price_per_kwh NUMERIC(14, 6);

-- ── orders.labor_cost — operator-entered labour cost for the order ──
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS labor_cost NUMERIC(12, 2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_labor_cost_nonnegative_check'
      AND conrelid = 'public.orders'::regclass
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_labor_cost_nonnegative_check
        CHECK (labor_cost IS NULL OR labor_cost >= 0);
  END IF;
END $$;

COMMIT;
