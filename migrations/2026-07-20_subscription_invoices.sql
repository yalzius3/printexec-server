-- ================================================================
-- SUBSCRIPTION INVOICES: PrintExec-issued invoices for a company's plan.
--
-- When a company's subscription is activated onto a real plan — a grant code
-- redeemed, a plan assigned by an admin, or (later) a payment settled — the
-- platform issues an invoice and emails it to the owner. This is the durable
-- record behind that email: what was billed, for which period, to whom, and
-- whether the email went out.
--
--   · invoice_number — human, sequential, per year: PX-INV-YYYY-NNNNN. Minted
--     atomically from subscription_invoice_sequences (same row-lock upsert as
--     order_number_sequences) so two concurrent activations never collide.
--   · amount_usd — the charge. 0 for complimentary access (grant codes); the
--     plan's list price for a manual paid assignment; the settled amount when
--     a provider is wired up. Enterprise/contact-only plans carry 0 + a
--     "per agreement" note (billed off-platform).
--   · source — how the subscription was obtained (grant_code | manual |
--     stripe | payoneer …), mirroring company_subscriptions.source.
--   · period_start / period_end — the billing period the invoice covers.
--     period_end NULL = ongoing / indefinite access.
--   · email_status — sent | dry_run | skipped | failed (the outcome of the
--     owner email; mirrors the order_emails / license_emails convention).
--
-- Server-only bookkeeping (all access flows through the API): RLS enabled with
-- no policies, same posture as license_emails / terms_acceptances / finance.
--
-- Idempotent: safe to re-run.
-- ================================================================

BEGIN;

-- Per-year atomic counter for the human invoice number (mirrors
-- order_number_sequences: INSERT ... ON CONFLICT DO UPDATE row-locks the year).
CREATE TABLE IF NOT EXISTS public.subscription_invoice_sequences (
  year       INTEGER PRIMARY KEY,
  last_value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS public.subscription_invoices (
  invoice_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES public.companies(company_id) ON DELETE CASCADE,
  -- PX-INV-YYYY-NNNNN. UNIQUE so a mis-retry can't mint a duplicate number.
  invoice_number  TEXT NOT NULL UNIQUE,
  plan_code       TEXT,
  plan_name       TEXT,
  amount_usd      NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (amount_usd >= 0),
  currency        TEXT NOT NULL DEFAULT 'USD',
  -- grant_code | manual | stripe | payoneer …
  source          TEXT NOT NULL,
  period_start    TIMESTAMPTZ,
  period_end      TIMESTAMPTZ,
  -- issued | void
  status          TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'void')),
  recipient_email TEXT,
  -- Outcome of the owner email for this invoice.
  email_status    TEXT CHECK (email_status IN ('sent', 'dry_run', 'skipped', 'failed')),
  email_error     TEXT,
  -- Free-text ("Complimentary access", "Billed per agreement", …).
  note            TEXT,
  -- Platform-admin email when an admin triggered it; 'system' otherwise.
  issued_by       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tenant + admin both read a company's invoices newest-first.
CREATE INDEX IF NOT EXISTS subscription_invoices_company_idx
  ON public.subscription_invoices (company_id, created_at DESC);

-- Backs the "did we already invoice this exact activation?" dedupe guard
-- (company + plan + period + source), so re-redeeming or re-saving the same
-- plan doesn't double-invoice.
CREATE INDEX IF NOT EXISTS subscription_invoices_dedupe_idx
  ON public.subscription_invoices (company_id, source, plan_code, period_end);

ALTER TABLE public.subscription_invoices ENABLE ROW LEVEL SECURITY;

COMMIT;
