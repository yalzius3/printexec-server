-- ================================================================
-- Two nullable money columns. Additive only — nothing else touched.
-- Safe to re-run.
--   companies.electricity_price_per_watt  — cost of one watt of electricity
--   users.monthly_salary                  — per company member
-- ================================================================

BEGIN;

-- ── companies.electricity_price_per_watt ─────────────────────────
-- Small unit price → 6 decimals. Nullable: unset until priced.
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS electricity_price_per_watt NUMERIC(14, 6);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'companies_electricity_price_nonnegative_check'
      AND conrelid = 'public.companies'::regclass
  ) THEN
    ALTER TABLE public.companies
      ADD CONSTRAINT companies_electricity_price_nonnegative_check
        CHECK (electricity_price_per_watt IS NULL OR electricity_price_per_watt >= 0);
  END IF;
END $$;

-- ── users.monthly_salary ─────────────────────────────────────────
-- Money with cents. Nullable: unset until entered.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS monthly_salary NUMERIC(12, 2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_monthly_salary_nonnegative_check'
      AND conrelid = 'public.users'::regclass
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_monthly_salary_nonnegative_check
        CHECK (monthly_salary IS NULL OR monthly_salary >= 0);
  END IF;
END $$;

COMMIT;
