-- ================================================================
-- COSTING VARIABLES: reusable capital-recovery / margin calculators.
--
-- A costing variable answers "how much margin must each order carry to recover
-- a cost over a payback window". The worked case:
--   asset cost 1,000,000 over 10 months at 50 orders/month
--     -> 1,000,000 / (10 * 50) = 2,000 per order.
--
-- Variables are named and reusable: several printers each have their own
-- payback plan, and the Orders pricing screen reads the active variables as an
-- optional recovery margin to fold into a quote (analogous to profit_pct).
--
-- asset_id is a soft link (no FK) to a printer_instances.printer_id; asset_cost
-- is snapshotted so the calculation survives the asset being deleted or
-- re-priced. computed_value is the per-order margin, recomputed by the app on
-- every write so the Orders side can SUM active rows cheaply.
--
-- Server-only table (RLS enabled, no policies) like the rest of finance.
-- Idempotent; safe to re-run.
-- ================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.costing_variables (
  costing_id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                UUID          NOT NULL REFERENCES public.companies(company_id) ON DELETE CASCADE,
  name                      TEXT          NOT NULL,
  -- asset_recovery: derive per-order margin from an asset cost + payback plan.
  -- manual: a directly-entered per-order margin.
  kind                      TEXT          NOT NULL DEFAULT 'asset_recovery'
                              CHECK (kind IN ('asset_recovery', 'manual')),
  -- Soft link + snapshot of the recovered asset (a printer today). No FK: the
  -- snapshot keeps the plan valid even if the asset is later removed.
  asset_id                  UUID,
  asset_kind                TEXT          CHECK (asset_kind IS NULL OR asset_kind IN ('printer', 'spool', 'other')),
  asset_label               TEXT,
  asset_cost                NUMERIC(14,2) CHECK (asset_cost IS NULL OR asset_cost >= 0),
  payback_months            INTEGER       CHECK (payback_months IS NULL OR payback_months > 0),
  expected_volume_per_month NUMERIC(12,2) CHECK (expected_volume_per_month IS NULL OR expected_volume_per_month > 0),
  -- Per-order recovery margin. App-computed on every write:
  --   asset_recovery -> asset_cost / (payback_months * expected_volume_per_month)
  --   manual         -> the entered amount
  computed_value            NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (computed_value >= 0),
  is_active                 BOOLEAN       NOT NULL DEFAULT TRUE,
  notes                     TEXT,
  created_by                UUID          REFERENCES public.users(id) ON DELETE SET NULL,
  created_at                TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_costing_variables_company
  ON public.costing_variables (company_id, is_active);

ALTER TABLE public.costing_variables ENABLE ROW LEVEL SECURITY;

COMMIT;
