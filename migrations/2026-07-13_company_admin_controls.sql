-- ================================================================
-- COMPANY ADMIN CONTROLS: platform-owner moderation holds, soft delete,
-- and in-app messages to a company.
--
--   admin_hold — an explicit platform decision that OVERRIDES the computed
--     billing state (see LicensingService.resolve):
--       grace     → workspace nagged + printer adds blocked (rest works)
--       suspended → workspace read-only (all mutations blocked)
--       banned    → full lockout (reads 403 too; the app shows a lock screen)
--     NULL = no hold (the normal billing state applies).
--   deleted_at — soft delete: full lockout, hidden by default, but all data is
--     retained so a platform admin can restore the company.
--   company_admin_messages — notices the platform sends to one company, shown
--     as a dismissible in-app banner (surfaced via /auth/me + /licensing).
--
-- Unlike the billing gate (LICENSING_ENFORCED dry-run), these admin holds are
-- enforced IMMEDIATELY in the LicenseGuard — they are deliberate, per-company
-- decisions. Platform admins reach the admin area through @LicenseExempt
-- routes, so they can never lock themselves out of undoing a hold.
--
-- Idempotent: safe to re-run.
-- ================================================================

BEGIN;

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS admin_hold        TEXT
    CHECK (admin_hold IN ('grace', 'suspended', 'banned')),
  ADD COLUMN IF NOT EXISTS admin_hold_reason TEXT,
  ADD COLUMN IF NOT EXISTS admin_hold_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS admin_hold_by     TEXT,
  ADD COLUMN IF NOT EXISTS deleted_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by        TEXT;

CREATE TABLE IF NOT EXISTS public.company_admin_messages (
  message_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID NOT NULL REFERENCES public.companies(company_id) ON DELETE CASCADE,
  body         TEXT NOT NULL,
  -- Platform-admin email that sent the message (informational).
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set when the tenant dismisses the in-app banner.
  dismissed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS company_admin_messages_company_idx
  ON public.company_admin_messages (company_id, created_at DESC);

COMMIT;
