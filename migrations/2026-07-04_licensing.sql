-- ================================================================
-- LICENSING: plans, per-company subscriptions, and grant codes.
--
-- The licensing gate resolves every company to exactly one state:
--
--   ok        → plan valid and under its printer cap; nothing is blocked.
--   grace     → plan expired/revoked OR printer count exceeds the cap.
--               Adding printers is blocked; everything else still works.
--               Lasts LICENSE_GRACE_DAYS (app env, default 14).
--   readonly  → the grace window lapsed. All mutations are blocked
--               server-side (GETs and the licensing endpoints stay open
--               so the tenant can see their data and fix their plan).
--
-- Three pieces:
--   1. plans — the tier catalogue. Printer caps are DATA, not code: change
--      a cap with an UPDATE, no deploy. NULL max_printers = unlimited.
--      Seeded tiers: trial (25, hidden), starter (10), growth (25),
--      enterprise (unlimited, hidden — sold by proposal, billed manually).
--   2. company_subscriptions — one row per company: which plan, how it was
--      obtained (trial / manual / grant_code / stripe), whether it is still
--      valid, and when it lapses. Stripe columns are pre-provisioned so the
--      later Stripe pass only flips these rows via webhooks — no reshape.
--   3. license_grants — platform-owner grant codes. A code carries a plan
--      and is redeemed by exactly one company, which then holds that plan
--      free until the code is revoked (revocation drops the company into
--      the normal grace → readonly flow).
--
-- Existing companies are backfilled with a fresh trial starting at apply
-- time, so nobody is locked out on rollout. New companies get their trial
-- row from the app at setup (with a lazy fallback in the license resolver).
--
-- These are server-only bookkeeping tables: the client never touches them
-- directly (all client data flows through the API), so they are intentionally
-- not surfaced to the Data API. Follow the project's existing public-schema
-- RLS posture if that ever changes.
--
-- Idempotent: safe to re-run.
-- ================================================================

BEGIN;

-- ---------------------------------------------------------------
-- 1. plans — tier catalogue (caps are data, editable without deploy)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.plans (
  plan_code    TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  -- NULL = unlimited printers.
  max_printers INTEGER,
  -- Public plans appear on the tenant-facing plan screen. trial and
  -- enterprise are assigned, never self-picked.
  is_public    BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.plans (plan_code, display_name, max_printers, is_public, sort_order)
VALUES
  ('trial',      'Trial',      25,   FALSE, 0),
  ('starter',    'Starter',    10,   TRUE,  1),
  ('growth',     'Growth',     25,   TRUE,  2),
  ('enterprise', 'Enterprise', NULL, FALSE, 3)
ON CONFLICT (plan_code) DO NOTHING;

-- ---------------------------------------------------------------
-- 2. license_grants — platform-owner grant codes
-- ---------------------------------------------------------------
-- Created BEFORE company_subscriptions so its FK can reference this table.
CREATE TABLE IF NOT EXISTS public.license_grants (
  grant_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                    TEXT NOT NULL UNIQUE,
  plan_code               TEXT NOT NULL REFERENCES public.plans(plan_code),
  note                    TEXT,
  -- Platform-admin email that minted the code (informational).
  created_by              TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Optional hard end date for the granted access. NULL = until revoked.
  expires_at              TIMESTAMPTZ,
  revoked_at              TIMESTAMPTZ,
  -- Single-use: set on redemption; a redeemed code can never be redeemed again.
  redeemed_by_company_id  UUID REFERENCES public.companies(company_id) ON DELETE SET NULL,
  redeemed_at             TIMESTAMPTZ
);

-- ---------------------------------------------------------------
-- 3. company_subscriptions — one licensing row per company
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.company_subscriptions (
  company_id            UUID PRIMARY KEY REFERENCES public.companies(company_id) ON DELETE CASCADE,
  plan_code             TEXT NOT NULL REFERENCES public.plans(plan_code),
  -- trialing → on the seeded trial. active → valid plan.
  -- canceled → tenant/admin ended it. revoked → grant code was revoked.
  status                TEXT NOT NULL DEFAULT 'trialing'
                          CHECK (status IN ('trialing', 'active', 'canceled', 'revoked')),
  -- How the current plan was obtained. Stripe rows arrive in a later pass.
  source                TEXT NOT NULL DEFAULT 'trial'
                          CHECK (source IN ('trial', 'manual', 'grant_code', 'stripe')),
  -- When the current plan lapses. NULL = indefinite (manual/grant access).
  -- Also the grace-window anchor once it has passed.
  current_period_end    TIMESTAMPTZ,
  -- Set by the license resolver the first time it observes the company over
  -- its printer cap; cleared when the company is back under. Anchors the
  -- over-limit grace window ("block adds for N days, then read-only").
  limit_exceeded_since  TIMESTAMPTZ,
  -- The grant code backing this subscription when source = 'grant_code'.
  grant_id              UUID REFERENCES public.license_grants(grant_id) ON DELETE SET NULL,
  -- Pre-provisioned for the Stripe pass (checkout + webhooks) — unused today.
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------
-- 4. Backfill: every existing company starts a fresh 14-day trial at
--    apply time (NULLs only via ON CONFLICT, so re-runs are no-ops).
-- ---------------------------------------------------------------
INSERT INTO public.company_subscriptions
  (company_id, plan_code, status, source, current_period_end)
SELECT
  c.company_id, 'trial', 'trialing', 'trial', now() + INTERVAL '14 days'
FROM public.companies c
ON CONFLICT (company_id) DO NOTHING;

COMMIT;
