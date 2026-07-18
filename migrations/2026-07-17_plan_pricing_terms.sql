-- ================================================================
-- PLAN PRICING + TERMS OF USE + CHECKOUT INTENT.
--
-- Backs the new pre-workspace onboarding gate (signup → choose a plan +
-- accept the Terms of Use → create the company) and readies the licensing
-- layer for the payment-provider pass (Payoneer planned):
--
--   1. plans — becomes the full public pricing catalogue. Price, blurb and
--      feature bullets are DATA (change them with an UPDATE, no deploy),
--      matching the existing "caps are data" convention. `self_serve`
--      separates "shown on the plan screen" (is_public) from "purchasable
--      in-app" — Enterprise becomes visible but contact-only; trial stays
--      hidden machinery.
--
--        !! Seeded prices: Starter 79 / Growth 200 (USD/mo). Change with:
--        !!   UPDATE plans SET price_monthly_usd = <n> WHERE plan_code = '…';
--
--   2. company_subscriptions.selected_plan_code — the plan the owner picked
--      while payments are still offline. Everyone runs on the free trial
--      until checkout exists; this records intent so the payment pass can
--      prompt exactly the right checkout with zero re-asking.
--
--   3. terms_acceptances + users.tos_* — click-wrap record for the Terms of
--      Use. The append-only table is the durable legal artifact (auth user
--      id, version, timestamp, ip/user-agent); the users columns are the
--      fast "has this member accepted the CURRENT version?" flag that
--      /auth/me reads to drive the re-accept interstitial.
--
-- The server code is pre-migration-safe (every read/write of these columns
-- falls back or logs), but the new onboarding only fully works once this is
-- applied. Idempotent: safe to re-run; seeds never clobber founder edits.
-- ================================================================

BEGIN;

-- ---------------------------------------------------------------
-- 1. plans → public pricing catalogue
-- ---------------------------------------------------------------
ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS price_monthly_usd NUMERIC(8,2);
ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS blurb TEXT;
ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS features JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS self_serve BOOLEAN NOT NULL DEFAULT TRUE;

-- Enterprise: visible on the plan screens, but sold by contact, never by
-- checkout. Trial: internal machinery, neither shown nor purchasable.
UPDATE public.plans SET is_public = TRUE,  self_serve = FALSE WHERE plan_code = 'enterprise';
UPDATE public.plans SET is_public = FALSE, self_serve = FALSE WHERE plan_code = 'trial';

-- Seed copy + prices ONLY where still unset, so re-runs and founder edits
-- both survive. Feature lists mirror the client fallback + website /pricing
-- (three repos — keep in lockstep). Lorelei (the AI analyst) is a Growth+
-- feature: Starter deliberately omits it.
UPDATE public.plans SET price_monthly_usd = 79  WHERE plan_code = 'starter' AND price_monthly_usd IS NULL;
UPDATE public.plans SET price_monthly_usd = 200 WHERE plan_code = 'growth'  AND price_monthly_usd IS NULL;

UPDATE public.plans SET blurb = 'For small farms getting organized.'
  WHERE plan_code = 'starter' AND blurb IS NULL;
UPDATE public.plans SET blurb = 'For growing farms running at pace.'
  WHERE plan_code = 'growth' AND blurb IS NULL;
UPDATE public.plans SET blurb = 'For large fleets and custom requirements.'
  WHERE plan_code = 'enterprise' AND blurb IS NULL;

UPDATE public.plans SET features = '["Up to 10 printers","Orders, jobs & scheduling","Assets, spools & maintenance","Invoicing & customer CRM","Finance & analytics dashboards"]'::jsonb
  WHERE plan_code = 'starter' AND features = '[]'::jsonb;
UPDATE public.plans SET features = '["Everything in Starter","Up to 25 printers","Lorelei AI analyst, in the dashboard","Priority support","Early access to new modules"]'::jsonb
  WHERE plan_code = 'growth' AND features = '[]'::jsonb;
UPDATE public.plans SET features = '["Everything in Growth","Unlimited printers","Tailored onboarding","Dedicated support","Custom contract & billing"]'::jsonb
  WHERE plan_code = 'enterprise' AND features = '[]'::jsonb;

-- ---------------------------------------------------------------
-- 2. company_subscriptions → checkout intent
-- ---------------------------------------------------------------
ALTER TABLE public.company_subscriptions
  ADD COLUMN IF NOT EXISTS selected_plan_code TEXT REFERENCES public.plans(plan_code);

-- ---------------------------------------------------------------
-- 3. Terms of Use acceptance
-- ---------------------------------------------------------------
-- Append-only click-wrap ledger. user_id is the AUTH user id (uuid) — kept
-- as a plain column, not an FK, because acceptance is recorded at signup
-- before the app's users row exists and must survive account deletion.
CREATE TABLE IF NOT EXISTS public.terms_acceptances (
  acceptance_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL,
  email         TEXT,
  terms_version TEXT NOT NULL,
  accepted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip            TEXT,
  user_agent    TEXT
);

CREATE INDEX IF NOT EXISTS idx_terms_acceptances_user
  ON public.terms_acceptances (user_id, terms_version);

-- Server-only bookkeeping (all access flows through the API); RLS with no
-- policies blocks any Data-API role, same posture as the finance tables.
ALTER TABLE public.terms_acceptances ENABLE ROW LEVEL SECURITY;

-- Fast per-member flag for the current-version check in /auth/me.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS tos_accepted_at TIMESTAMPTZ;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS tos_version TEXT;

COMMIT;
