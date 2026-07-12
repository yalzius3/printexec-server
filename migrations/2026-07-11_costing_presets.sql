-- ================================================================
-- COSTING PRESETS: reusable pricing formulas for the Orders module.
--
-- Today an order sells for base_cost × (1 + profit_pct) — one hard-coded lever.
-- A preset replaces that with a named, editable equation over a fixed set of
-- symbols (base, material, electricity, labor, variables, custom, margin,
-- orders_per_month), e.g.
--     (base + variables) * (1 + margin) + custom
-- The formula is a plain arithmetic string; the app parses + evaluates it with a
-- shared safe evaluator (orders/costing-formula.ts) — never SQL, never eval().
--
-- `is_default` is the preset new orders start on (the app keeps at most one per
-- company). `default_variable_ids` seeds which Finance costing_variables an order
-- folds into `variables` when the preset is applied; the order can then add or
-- remove variables and drop in ad-hoc custom charges (stored on the order).
--
-- Orders gain two columns:
--   costing_preset_id  which preset prices the order (NULL ⇒ legacy base×(1+margin))
--   costing_config     the per-order tweak: chosen variables, custom lines,
--                      and an optional margin override (JSONB, app-shaped)
--
-- Server-only table (RLS enabled, no policies) like the rest of finance/costing.
-- Idempotent; safe to re-run.
-- ================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.costing_presets (
  preset_id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           UUID        NOT NULL REFERENCES public.companies(company_id) ON DELETE CASCADE,
  name                 TEXT        NOT NULL,
  -- The pricing equation, over the whitelisted costing symbols. Validated by the
  -- app (parse + allowed-identifier check) before it is ever stored here.
  formula              TEXT        NOT NULL,
  -- costing_variables the order folds into `variables` when this preset is picked.
  -- Soft references (no FK on the array); the app sums only the ones still active.
  default_variable_ids UUID[]      NOT NULL DEFAULT '{}',
  -- At most one default per company (enforced by the app, not a DB constraint,
  -- so switching the default is a plain two-row update).
  is_default           BOOLEAN     NOT NULL DEFAULT FALSE,
  is_active            BOOLEAN     NOT NULL DEFAULT TRUE,
  notes                TEXT,
  created_by           UUID        REFERENCES public.users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_costing_presets_company
  ON public.costing_presets (company_id, is_active);

ALTER TABLE public.costing_presets ENABLE ROW LEVEL SECURITY;

-- Which preset prices an order. FK with ON DELETE SET NULL: deleting a preset
-- drops affected orders back to the legacy base×(1+margin) rather than dangling.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS costing_preset_id UUID
    REFERENCES public.costing_presets(preset_id) ON DELETE SET NULL;

-- Per-order pricing tweak, app-shaped:
--   { "variable_ids": ["<uuid>", ...],
--     "custom_lines": [{ "label": "Rush fee", "amount": 500 }, ...],
--     "margin_override_pct": 45 | null }
-- profit_pct stays the canonical margin override; margin_override_pct is only a
-- convenience mirror the app keeps in sync with it.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS costing_config JSONB;

COMMIT;
