-- ================================================================
-- CUSTOM PLANS: base + overage pricing, and a minimum monthly charge.
--
-- Extends the custom-plan layer from 2026-07-22_custom_plans_admin_audit.sql
-- with the shape most enterprise contracts actually take:
--
--     "$500/month covers 50 printers; every printer above that is $9.08"
--     "$500/month covers 50 printers; each extra block of 10 is $69"
--
-- i.e. a fixed base that INCLUDES an allowance, then metered overage above it,
-- billed either per printer or per bundle. That is the new
-- custom_price_model = 'base_plus_overage':
--
--     custom_base_amount        the fixed monthly base
--     custom_included_printers  how many printers that base covers
--     custom_overage_model      how printers ABOVE the allowance are billed:
--                                 per_printer → amount × extra printers
--                                 bundle      → amount × ceil(extra / size)
--                                 NULL        → no overage (base is the lot)
--     (the overage unit price reuses custom_price_amount, and the overage
--      bundle size reuses custom_bundle_size — they are always "the money
--      input for the variable part", whichever model is in play)
--
-- Independently, custom_min_monthly is an optional FLOOR that applies to any
-- model ("$9.08 per printer, minimum $500/month"). It never lowers a price,
-- only raises it to the floor.
--
-- Separate migration from the one that introduced custom_*: that file may
-- already be applied, and rewriting an applied migration is how you end up
-- with two environments that disagree. Idempotent: safe to re-run.
-- ================================================================

BEGIN;

ALTER TABLE public.company_subscriptions
  ADD COLUMN IF NOT EXISTS custom_base_amount       NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS custom_included_printers INTEGER,
  ADD COLUMN IF NOT EXISTS custom_overage_model     TEXT,
  ADD COLUMN IF NOT EXISTS custom_min_monthly       NUMERIC(10,2);

DO $$
BEGIN
  -- Allow the new model alongside the original three. The old constraint is
  -- dropped and re-created because CHECK constraints can't be extended.
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'company_subscriptions_custom_price_model_chk'
  ) THEN
    ALTER TABLE public.company_subscriptions
      DROP CONSTRAINT company_subscriptions_custom_price_model_chk;
  END IF;
  ALTER TABLE public.company_subscriptions
    ADD CONSTRAINT company_subscriptions_custom_price_model_chk
    CHECK (custom_price_model IS NULL
           OR custom_price_model IN ('flat', 'per_printer', 'bundle', 'base_plus_overage'));

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'company_subscriptions_custom_overage_chk'
  ) THEN
    ALTER TABLE public.company_subscriptions
      ADD CONSTRAINT company_subscriptions_custom_overage_chk
      CHECK (custom_overage_model IS NULL OR custom_overage_model IN ('per_printer', 'bundle'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'company_subscriptions_custom_overage_amounts_chk'
  ) THEN
    ALTER TABLE public.company_subscriptions
      ADD CONSTRAINT company_subscriptions_custom_overage_amounts_chk
      CHECK (
        (custom_base_amount IS NULL OR custom_base_amount >= 0)
        AND (custom_included_printers IS NULL OR custom_included_printers >= 0)
        AND (custom_min_monthly IS NULL OR custom_min_monthly >= 0)
      );
  END IF;

  -- base_plus_overage is meaningless without a base to charge.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'company_subscriptions_custom_base_chk'
  ) THEN
    ALTER TABLE public.company_subscriptions
      ADD CONSTRAINT company_subscriptions_custom_base_chk
      CHECK (custom_price_model IS DISTINCT FROM 'base_plus_overage'
             OR custom_base_amount IS NOT NULL);
  END IF;

  -- The pre-existing "a price model needs custom_price_amount" rule doesn't
  -- hold for base_plus_overage: its amount lives in custom_base_amount, and
  -- custom_price_amount is only needed when there IS metered overage.
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'company_subscriptions_custom_priced_chk'
  ) THEN
    ALTER TABLE public.company_subscriptions
      DROP CONSTRAINT company_subscriptions_custom_priced_chk;
  END IF;
  ALTER TABLE public.company_subscriptions
    ADD CONSTRAINT company_subscriptions_custom_priced_chk
    CHECK (
      custom_price_model IS NULL
      OR custom_price_model = 'base_plus_overage'
      OR custom_price_amount IS NOT NULL
    );

  -- Metered overage priced per bundle needs a bundle size.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'company_subscriptions_custom_overage_bundle_chk'
  ) THEN
    ALTER TABLE public.company_subscriptions
      ADD CONSTRAINT company_subscriptions_custom_overage_bundle_chk
      CHECK (custom_overage_model IS DISTINCT FROM 'bundle' OR custom_bundle_size IS NOT NULL);
  END IF;
END $$;

COMMIT;
