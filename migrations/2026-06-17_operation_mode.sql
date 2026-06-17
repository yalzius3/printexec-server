-- ================================================================
-- OPERATION MODE: per-company Advanced | Simple, stamped onto orders
-- Additive only — no Advanced behaviour changes. Safe to re-run.
-- ================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────
-- STEP 1: companies.operation_mode  (default 'advanced')
-- The company-wide mode. Existing companies stay on 'advanced'.
-- ────────────────────────────────────────────────────────────────
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS operation_mode TEXT NOT NULL DEFAULT 'advanced';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'companies_operation_mode_check'
      AND conrelid = 'public.companies'::regclass
  ) THEN
    ALTER TABLE public.companies
      ADD CONSTRAINT companies_operation_mode_check
        CHECK (operation_mode IN ('advanced', 'simple'));
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────
-- STEP 2: orders.operation_mode  — which mode an order "lives" in.
-- Existing orders backfill to 'advanced' via the column default.
-- ────────────────────────────────────────────────────────────────
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS operation_mode TEXT NOT NULL DEFAULT 'advanced';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_operation_mode_check'
      AND conrelid = 'public.orders'::regclass
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_operation_mode_check
        CHECK (operation_mode IN ('advanced', 'simple'));
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────
-- STEP 3: Stamp each new order with its company's current mode, via a
-- BEFORE INSERT trigger — so the application's order-create code is
-- never touched. (Column defaults run before BEFORE triggers, so the
-- trigger overrides 'advanced' with the live company mode.)
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_order_operation_mode()
RETURNS TRIGGER AS $$
BEGIN
  NEW.operation_mode := COALESCE(
    (SELECT operation_mode FROM public.companies WHERE company_id = NEW.company_id),
    'advanced'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_order_operation_mode ON public.orders;
CREATE TRIGGER trg_set_order_operation_mode
  BEFORE INSERT ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.set_order_operation_mode();

-- Index for the per-mode list filters (orders are always scoped by company).
CREATE INDEX IF NOT EXISTS orders_company_operation_mode_idx
  ON public.orders (company_id, operation_mode);

COMMIT;
