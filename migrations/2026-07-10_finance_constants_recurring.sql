-- ================================================================
-- FINANCE CONSTANTS + RECURRING BILLS
--
--   1. finance_constants -- per-tenant tunables (default profit margin, avg
--      orders/month, ...). Each has an app-computed auto_value and an optional
--      user override; the effective value is COALESCE(override, auto, default).
--      avg_orders_per_month is recomputed from order history once >= 2 calendar
--      months of orders exist; until then the override/default stands.
--   2. recurring_bills -- routine bills (Monthly Rent, ...): an editable
--      template that posts a real bill each period. Their active monthly total
--      is the "Rent"-style fixed cost surfaced on the Costing page.
--
-- Server-only tables (RLS enabled, no policies) like the rest of finance.
-- Idempotent; safe to re-run.
-- ================================================================

BEGIN;

-- ---------------------------------------------------------------
-- 1. finance_constants
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.finance_constants (
  company_id       UUID        NOT NULL REFERENCES public.companies(company_id) ON DELETE CASCADE,
  -- Stable identifier the app knows: 'default_profit_margin_pct',
  -- 'avg_orders_per_month'.
  key              TEXT        NOT NULL,
  -- User override; NULL means "use the auto value".
  override_value   NUMERIC(14,4),
  -- Last app-computed value (e.g. avg orders/month from history).
  auto_value       NUMERIC(14,4),
  auto_computed_at TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, key)
);

-- ---------------------------------------------------------------
-- 2. recurring_bills
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.recurring_bills (
  recurring_bill_id  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         UUID          NOT NULL REFERENCES public.companies(company_id) ON DELETE CASCADE,
  name               TEXT          NOT NULL,
  vendor_id          UUID          REFERENCES public.vendors(vendor_id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  vendor_name        TEXT,
  amount             NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  -- Which expense/asset account a posted bill's single line lands on.
  expense_account_id UUID          REFERENCES public.finance_accounts(account_id) DEFERRABLE INITIALLY DEFERRED,
  cadence            TEXT          NOT NULL DEFAULT 'monthly' CHECK (cadence IN ('monthly')),
  day_of_month       INTEGER       CHECK (day_of_month IS NULL OR (day_of_month BETWEEN 1 AND 28)),
  is_active          BOOLEAN       NOT NULL DEFAULT TRUE,
  notes              TEXT,
  -- 'YYYY-MM' of the last period a real bill was generated for (dedupe guard).
  last_posted_period TEXT,
  created_by         UUID          REFERENCES public.users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recurring_bills_company
  ON public.recurring_bills (company_id, is_active);

ALTER TABLE public.finance_constants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recurring_bills   ENABLE ROW LEVEL SECURITY;

COMMIT;
