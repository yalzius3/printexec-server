-- ================================================================
-- DISCOUNT CODES: platform-issued price reductions on a plan.
--
-- A discount code lowers what a company is billed for its plan. Unlike a
-- LICENSE GRANT (license_grants — which hands over a plan outright, for free,
-- until revoked), a discount code keeps the subscription a normal paid one and
-- only reduces the amount on the invoice:
--
--   percent → N% off the plan's price      (value 0–100)
--   fixed   → N USD off the plan's price   (never below zero)
--
-- Scope + limits are data, not code:
--   plan_code       NULL = valid on any plan, else restricted to that tier
--   max_redemptions NULL = unlimited, else the code stops working after N uses
--   expires_at      NULL = no end date
--   active          instant off switch that keeps the record + history
--
-- Redemptions are recorded per company so usage is auditable and the
-- max_redemptions cap is countable; a company can hold the same code only
-- once (UNIQUE), which also makes re-applying it idempotent.
--
-- Server-only bookkeeping (all access flows through the API): RLS enabled with
-- no policies, same posture as license_emails / subscription_invoices.
--
-- Idempotent: safe to re-run.
-- ================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.discount_codes (
  discount_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stored uppercase; looked up case-insensitively.
  code            TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL CHECK (kind IN ('percent', 'fixed')),
  -- percent → 0–100; fixed → USD off. CHECK keeps percent sane.
  value           NUMERIC(10,2) NOT NULL CHECK (value >= 0),
  CONSTRAINT discount_codes_percent_range
    CHECK (kind <> 'percent' OR value <= 100),
  -- NULL = valid on any plan.
  plan_code       TEXT REFERENCES public.plans(plan_code),
  description     TEXT,
  -- NULL = unlimited uses.
  max_redemptions INTEGER CHECK (max_redemptions IS NULL OR max_redemptions > 0),
  expires_at      TIMESTAMPTZ,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.discount_redemptions (
  redemption_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discount_id   UUID NOT NULL REFERENCES public.discount_codes(discount_id) ON DELETE CASCADE,
  company_id    UUID NOT NULL REFERENCES public.companies(company_id) ON DELETE CASCADE,
  -- What the discount actually took off, in USD, at redemption time.
  amount_off    NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (amount_off >= 0),
  redeemed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (discount_id, company_id)
);

CREATE INDEX IF NOT EXISTS discount_redemptions_discount_idx
  ON public.discount_redemptions (discount_id);

-- Record the discount that produced an invoice's amount, so a reduced charge
-- is explainable months later. Nullable: most invoices carry no discount.
ALTER TABLE public.subscription_invoices
  ADD COLUMN IF NOT EXISTS discount_code   TEXT,
  ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10,2);

ALTER TABLE public.discount_codes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discount_redemptions ENABLE ROW LEVEL SECURITY;

COMMIT;
