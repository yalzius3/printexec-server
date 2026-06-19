-- ================================================================
-- Company shop rate (hourly labour rate used by piece pricing).
-- Additive, nullable, non-negative. Safe to re-run.
-- ================================================================

BEGIN;

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS shop_rate NUMERIC(12, 4);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'companies_shop_rate_nonnegative_check'
      AND conrelid = 'public.companies'::regclass
  ) THEN
    ALTER TABLE public.companies
      ADD CONSTRAINT companies_shop_rate_nonnegative_check
        CHECK (shop_rate IS NULL OR shop_rate >= 0);
  END IF;
END $$;

COMMIT;
