-- ================================================================
-- LICENSE NOTIFICATIONS: owner-facing plan/trial emails + admin sends.
--
-- license_emails is the idempotency ledger AND audit log for every email the
-- PLATFORM sends a company owner about their plan (mirrors order_emails for
-- customer mail):
--
--   · Automatic notices — the LicenseNotificationsService sweep warns the
--     owner as their trial or paid period approaches its end and again once
--     it lapses / goes read-only:
--       trial_ending_7d / _3d / _1d → trial_ended
--       renewal_due_14d / _7d / _1d → plan_lapsed → plan_readonly
--   · admin_custom — one-off emails a platform admin composes in the
--     licensing admin area (single or bulk).
--
-- Dedupe: UNIQUE (company_id, email_type, period_anchor). period_anchor is
-- the current_period_end of the billing cycle the notice belongs to, so each
-- threshold fires AT MOST ONCE per cycle — and renewing/extending (a new
-- period end) naturally re-arms the whole ladder for the next cycle.
-- admin_custom rows use the send moment as their anchor, so they never
-- collide and are unlimited.
--
-- status mirrors the order_emails convention:
--   sent     → the transport accepted it
--   dry_run  → composed while EMAIL_ENABLED != "true" (nothing delivered)
--   skipped  → intentionally not sent (no owner email, superseded by a later
--              threshold, or stale backlog at rollout) — recorded so the
--              sweep stops rescanning it. Transport FAILURES are deliberately
--              NOT recorded: the notice stays eligible and retries next sweep.
--
-- Server-only bookkeeping (all access flows through the API): RLS enabled
-- with no policies, same posture as terms_acceptances / finance tables.
--
-- Idempotent: safe to re-run.
-- ================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.license_emails (
  license_email_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL REFERENCES public.companies(company_id) ON DELETE CASCADE,
  -- trial_ending_7d | trial_ending_3d | trial_ending_1d | trial_ended |
  -- renewal_due_14d | renewal_due_7d | renewal_due_1d | plan_lapsed |
  -- plan_readonly | admin_custom
  email_type       TEXT NOT NULL,
  -- The billing-cycle anchor this notice belongs to (current_period_end for
  -- automatic notices; the send moment for admin_custom).
  period_anchor    TIMESTAMPTZ NOT NULL,
  recipient_email  TEXT,
  subject          TEXT,
  body             TEXT,
  status           TEXT NOT NULL CHECK (status IN ('sent', 'dry_run', 'skipped')),
  -- Context for skipped rows ("no owner email", "superseded", "stale"), or a
  -- provider note. NULL on clean sends.
  error            TEXT,
  -- Platform-admin email for admin_custom sends (informational; NULL for
  -- automatic notices).
  created_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One settled row per (company, notice, billing cycle) — the sweep's
-- ON CONFLICT target.
CREATE UNIQUE INDEX IF NOT EXISTS license_emails_dedupe_idx
  ON public.license_emails (company_id, email_type, period_anchor);

-- Admin area reads a company's notice history newest-first.
CREATE INDEX IF NOT EXISTS license_emails_company_idx
  ON public.license_emails (company_id, created_at DESC);

ALTER TABLE public.license_emails ENABLE ROW LEVEL SECURITY;

COMMIT;
