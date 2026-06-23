-- ================================================================
-- orders.profit_pct — operator-entered profit margin (%) for the order,
-- applied on top of the order's base cost. Nullable, non-negative.
-- Additive, idempotent.
-- ================================================================

BEGIN;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS profit_pct NUMERIC(7, 2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_profit_pct_nonnegative_check'
      AND conrelid = 'public.orders'::regclass
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_profit_pct_nonnegative_check
        CHECK (profit_pct IS NULL OR profit_pct >= 0);
  END IF;
END $$;

COMMIT;
