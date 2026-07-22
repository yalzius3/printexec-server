-- ================================================================
-- PER-COMPANY LORELEI (AI analyst) MONTHLY BUDGET OVERRIDE.
--
-- Lorelei's usage is gated by a per-calendar-month USD spend cap, metered
-- from real model cost in ai_usage_events. The cap is a single deployment
-- default (env AI_BUDGET_USD, $1/month per company). This adds a per-company
-- override so a platform admin can raise (or lower) one tenant's allowance —
-- e.g. an Enterprise customer who leans on the analyst — without touching
-- everyone else.
--
--   companies.ai_monthly_budget_usd
--     NULL  → use the deployment default (env AI_BUDGET_USD)
--     >= 0  → this company's own monthly cap in USD (0 disables Lorelei for
--             them, matching the env "0 = no cap"? — NO: see note below)
--
-- NOTE on 0: env AI_BUDGET_USD=0 means "no cap" (unlimited). A per-company
-- override of 0 is ambiguous, so the analytics service treats a per-company
-- override of exactly 0 as "no cap for this company" for consistency with the
-- env semantics; the admin UI offers an explicit "unlimited" affordance so
-- this is never set by accident.
--
-- Only ever written by an unlocked platform admin (see the licensing admin
-- guard); never client-settable. Idempotent.
-- ================================================================

BEGIN;

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS ai_monthly_budget_usd NUMERIC(10,4);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'companies_ai_budget_nonneg_chk'
  ) THEN
    ALTER TABLE public.companies
      ADD CONSTRAINT companies_ai_budget_nonneg_chk
      CHECK (ai_monthly_budget_usd IS NULL OR ai_monthly_budget_usd >= 0);
  END IF;
END $$;

COMMIT;
