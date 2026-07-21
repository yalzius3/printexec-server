-- ================================================================
-- CUSTOM PER-COMPANY PLANS + PLATFORM-ADMIN AUDIT LOG.
--
-- Two independent pieces, shipped together because both exist to make the
-- licensing admin (the monetization surface) safe and flexible:
--
--   1. company_subscriptions.custom_* — a per-company override layer on top
--      of the plan catalogue. The catalogue tiers (Starter/Growth) stay
--      deliberately rigid; Enterprise deals are negotiated, so an admin can
--      pin a company to a plan and then override its printer cap and its
--      price without inventing a new global tier for every deal.
--
--        custom_max_printers   overrides plans.max_printers (NULL = use plan's)
--        custom_price_model    how the monthly price is derived:
--                                flat        → a fixed monthly amount
--                                per_printer → amount × units
--                                bundle      → ceil(units / bundle) × amount
--        custom_price_amount   the money input for the model above
--        custom_bundle_size    printers per bundle (bundle model only)
--        custom_billing_basis  what "units" means:
--                                cap    → the committed cap (buying slots)
--                                actual → printers actually in use
--        custom_label          tenant-facing name ("Enterprise — 100 printers")
--        custom_note           internal-only deal context
--
--      All of it is written ONLY by an authenticated + unlocked platform
--      admin (PlatformAdminGuard); nothing here is client-settable. The price
--      math lives in ONE place server-side (src/licensing/custom-plan.ts) so
--      the resolver, the invoice issuer and the admin UI can never disagree.
--
--   2. platform_admin_audit — an append-only record of every platform-admin
--      mutation (who, what, which company, the request body, ip/agent).
--      Licensing changes move money, so they must be attributable after the
--      fact. Written automatically by AdminAuditInterceptor.
--
-- Both are server-only bookkeeping: RLS is enabled with no policies, which
-- blocks every Data-API role outright (same posture as the finance tables).
--
-- Idempotent: safe to re-run.
-- ================================================================

BEGIN;

-- ---------------------------------------------------------------
-- 1. Per-company custom plan overrides
-- ---------------------------------------------------------------
ALTER TABLE public.company_subscriptions
  ADD COLUMN IF NOT EXISTS custom_max_printers  INTEGER,
  ADD COLUMN IF NOT EXISTS custom_price_model   TEXT,
  ADD COLUMN IF NOT EXISTS custom_price_amount  NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS custom_bundle_size   INTEGER,
  ADD COLUMN IF NOT EXISTS custom_billing_basis TEXT,
  ADD COLUMN IF NOT EXISTS custom_label         TEXT,
  ADD COLUMN IF NOT EXISTS custom_note          TEXT;

-- Value constraints, added separately so re-runs don't trip over an existing
-- constraint name. NULL passes every check (no custom plan set).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'company_subscriptions_custom_price_model_chk'
  ) THEN
    ALTER TABLE public.company_subscriptions
      ADD CONSTRAINT company_subscriptions_custom_price_model_chk
      CHECK (custom_price_model IS NULL OR custom_price_model IN ('flat', 'per_printer', 'bundle'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'company_subscriptions_custom_basis_chk'
  ) THEN
    ALTER TABLE public.company_subscriptions
      ADD CONSTRAINT company_subscriptions_custom_basis_chk
      CHECK (custom_billing_basis IS NULL OR custom_billing_basis IN ('cap', 'actual'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'company_subscriptions_custom_amounts_chk'
  ) THEN
    ALTER TABLE public.company_subscriptions
      ADD CONSTRAINT company_subscriptions_custom_amounts_chk
      CHECK (
        (custom_max_printers IS NULL OR custom_max_printers >= 0)
        AND (custom_price_amount IS NULL OR custom_price_amount >= 0)
        AND (custom_bundle_size IS NULL OR custom_bundle_size >= 1)
      );
  END IF;

  -- The bundle model is meaningless without a bundle size.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'company_subscriptions_custom_bundle_chk'
  ) THEN
    ALTER TABLE public.company_subscriptions
      ADD CONSTRAINT company_subscriptions_custom_bundle_chk
      CHECK (custom_price_model IS DISTINCT FROM 'bundle' OR custom_bundle_size IS NOT NULL);
  END IF;

  -- A price model needs an amount to price with.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'company_subscriptions_custom_priced_chk'
  ) THEN
    ALTER TABLE public.company_subscriptions
      ADD CONSTRAINT company_subscriptions_custom_priced_chk
      CHECK (custom_price_model IS NULL OR custom_price_amount IS NOT NULL);
  END IF;
END $$;

-- ---------------------------------------------------------------
-- 2. Platform-admin audit log (append-only)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.platform_admin_audit (
  audit_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Auth user id of the admin, plus the email they were allow-listed under
  -- at the time (kept verbatim: the allowlist can change later).
  admin_user_id UUID,
  admin_email   TEXT,
  -- "POST /licensing/admin/assign" — method + route path.
  action        TEXT NOT NULL,
  -- The company the action targeted, when the request named one. Deliberately
  -- NOT an FK: the audit trail must outlive a deleted company.
  company_id    UUID,
  -- Request body with secrets stripped, plus the outcome.
  details       JSONB,
  ok            BOOLEAN NOT NULL DEFAULT TRUE,
  ip            TEXT,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_platform_admin_audit_created
  ON public.platform_admin_audit (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_admin_audit_company
  ON public.platform_admin_audit (company_id, created_at DESC);

ALTER TABLE public.platform_admin_audit ENABLE ROW LEVEL SECURITY;

COMMIT;
