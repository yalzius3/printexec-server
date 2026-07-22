-- ================================================================
-- INVOICE DRAFT WORKFLOW + CUSTOM PLANS AS REUSABLE TIERS.
--
-- ── 1. Invoices are drafts, not tax documents ───────────────────
-- PrintExec is a product of ProArt Consulting — ProArt is the legal entity
-- that actually invoices customers, under its own tax-authority serial
-- numbers. An invoice this platform generates is therefore NOT a valid tax
-- document and must never reach a tenant on its own.
--
-- The lifecycle becomes:
--
--   draft  auto-generated on activation. Emailed to the operator
--          (INVOICE_DRAFT_EMAIL), NEVER to the tenant. Editable.
--     ↓    operator passes it to ProArt, who issues the real invoice
--   ready  operator has attached ProArt's finalized file + official serial
--     ↓
--   sent   that exact file has been emailed to the tenant
--   void   cancelled at any point
--
-- Legacy rows written under the old auto-send behaviour were already emailed
-- on creation, so they migrate to 'sent'.
--
--   official_number      ProArt's tax serial, from their series (not ours)
--   official_file_key    storage object holding ProArt's finalized PDF —
--                        the tenant receives THIS file byte-for-byte, never
--                        a re-render, so what they hold is the real invoice
--   draft_email_status   outcome of the draft email to the operator
--
-- invoice_number (PX-INV-YYYY-NNNNN) stays as our internal reference for
-- tracking a draft through the cycle; it is not presented as a tax number.
--
-- ── 2. Custom plans become reusable tiers ───────────────────────
-- A negotiated deal was previously per-company only. These columns let one be
-- saved into `plans` as a private tier, so it can then be ASSIGNED to other
-- companies or attached to a GRANT CODE like any catalogue plan. Precedence
-- stays: a company's own custom_* override wins, else its plan's terms, else
-- the plan list price.
--
-- Idempotent: safe to re-run.
-- ================================================================

BEGIN;

-- ---------------------------------------------------------------
-- 1. subscription_invoices → draft lifecycle
-- ---------------------------------------------------------------
ALTER TABLE public.subscription_invoices
  ADD COLUMN IF NOT EXISTS official_number     TEXT,
  ADD COLUMN IF NOT EXISTS official_file_key   TEXT,
  ADD COLUMN IF NOT EXISTS official_file_name  TEXT,
  ADD COLUMN IF NOT EXISTS finalized_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS finalized_by        TEXT,
  ADD COLUMN IF NOT EXISTS sent_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sent_to             TEXT,
  ADD COLUMN IF NOT EXISTS draft_email_status  TEXT,
  ADD COLUMN IF NOT EXISTS draft_email_error   TEXT,
  -- Set when an admin created/edited the row by hand rather than the
  -- activation hook, so the audit story stays legible.
  ADD COLUMN IF NOT EXISTS edited_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS edited_by           TEXT;

DO $$
DECLARE
  c record;
BEGIN
  -- Widen the status domain, migrating legacy rows first so the new CHECK
  -- can't reject data that predates it.
  --
  -- Drop every CHECK that constrains the `status` column — identified by the
  -- COLUMN it covers (conkey), not by text-matching its definition.
  --
  -- This matters: the table also carries email_status (and now
  -- draft_email_status) checks, whose definitions contain the substring
  -- "status". The first cut of this migration matched '%status%' and took
  -- LIMIT 1, so it dropped email_status's constraint and left
  -- status IN ('issued','void') in force — and the UPDATE below then failed
  -- with subscription_invoices_status_check. Matching on conkey can't make
  -- that mistake. Multi-column checks are deliberately left alone.
  FOR c IN
    SELECT con.conname
      FROM pg_constraint con
     WHERE con.conrelid = 'public.subscription_invoices'::regclass
       AND con.contype = 'c'
       AND con.conkey = ARRAY[(
             SELECT att.attnum
               FROM pg_attribute att
              WHERE att.attrelid = 'public.subscription_invoices'::regclass
                AND att.attname = 'status'
           )]
  LOOP
    EXECUTE format('ALTER TABLE public.subscription_invoices DROP CONSTRAINT %I', c.conname);
  END LOOP;

  -- Anything already 'issued' had been emailed to the owner under the old
  -- behaviour — that is exactly what 'sent' now means.
  UPDATE public.subscription_invoices SET status = 'sent' WHERE status = 'issued';

  -- Self-heal: the broken first cut of this migration dropped the
  -- email_status check by mistake. If that run committed before failing, put
  -- it back; if it rolled back (the normal case) this is a no-op.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.subscription_invoices'::regclass
       AND contype = 'c'
       AND conkey = ARRAY[(
             SELECT att.attnum FROM pg_attribute att
              WHERE att.attrelid = 'public.subscription_invoices'::regclass
                AND att.attname = 'email_status'
           )]
  ) THEN
    ALTER TABLE public.subscription_invoices
      ADD CONSTRAINT subscription_invoices_email_status_check
      CHECK (email_status IS NULL OR email_status IN ('sent', 'dry_run', 'skipped', 'failed'));
  END IF;

  -- Re-created unconditionally: the loop above also removed any earlier
  -- version of this constraint, so re-running the migration is safe.
  ALTER TABLE public.subscription_invoices
    ADD CONSTRAINT subscription_invoices_status_chk
    CHECK (status IN ('draft', 'ready', 'sent', 'void'));
END $$;

-- New invoices are drafts until an operator finalizes them.
ALTER TABLE public.subscription_invoices ALTER COLUMN status SET DEFAULT 'draft';

-- The admin's working queue: every draft/ready invoice, newest first.
CREATE INDEX IF NOT EXISTS subscription_invoices_status_idx
  ON public.subscription_invoices (status, created_at DESC);

-- ---------------------------------------------------------------
-- 2. plans → carry full pricing terms, and mark custom tiers
-- ---------------------------------------------------------------
-- Same vocabulary as company_subscriptions.custom_* (see custom-plan.ts):
-- flat | per_printer | bundle | base_plus_overage, counted on the committed
-- cap or actual usage, with an optional monthly floor.
ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS price_model       TEXT,
  ADD COLUMN IF NOT EXISTS price_amount      NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS bundle_size       INTEGER,
  ADD COLUMN IF NOT EXISTS billing_basis     TEXT,
  ADD COLUMN IF NOT EXISTS base_amount       NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS included_printers INTEGER,
  ADD COLUMN IF NOT EXISTS overage_model     TEXT,
  ADD COLUMN IF NOT EXISTS min_monthly       NUMERIC(10,2),
  -- TRUE for tiers minted from a negotiated deal. They are never public and
  -- never self-serve; they exist to be assigned or granted deliberately.
  ADD COLUMN IF NOT EXISTS is_custom         BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS created_by        TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plans_price_model_chk') THEN
    ALTER TABLE public.plans ADD CONSTRAINT plans_price_model_chk
      CHECK (price_model IS NULL
             OR price_model IN ('flat', 'per_printer', 'bundle', 'base_plus_overage'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plans_billing_basis_chk') THEN
    ALTER TABLE public.plans ADD CONSTRAINT plans_billing_basis_chk
      CHECK (billing_basis IS NULL OR billing_basis IN ('cap', 'actual'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plans_overage_model_chk') THEN
    ALTER TABLE public.plans ADD CONSTRAINT plans_overage_model_chk
      CHECK (overage_model IS NULL OR overage_model IN ('per_printer', 'bundle'));
  END IF;
END $$;

-- Custom tiers are listed separately in the admin; index the flag.
CREATE INDEX IF NOT EXISTS plans_is_custom_idx ON public.plans (is_custom, sort_order);

COMMIT;
