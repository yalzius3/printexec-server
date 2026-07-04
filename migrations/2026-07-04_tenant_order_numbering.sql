-- ================================================================
-- ORDER NUMBERING: tenant-scoped, year-reset, atomic sequences.
--
-- New business-facing order-number format:
--
--     <TENANT_CODE>-<YEAR>-<SEQUENCE>
--     e.g.  ABC-2026-00001, ABC-2026-00002, ABC-2027-00001, XYZ-2026-00001
--
-- This migration installs the *infrastructure* the application uses to mint
-- those numbers. It deliberately does NOT rewrite any existing order_number:
-- legacy ORD-YYYY-NNN numbers stay exactly as they are, and the new format
-- only applies to orders created from now on.
--
-- Three pieces:
--   1. companies.tenant_code — the stable per-tenant prefix. Derived once from
--      the company name (first three A-Z letters, upper-cased) by a BEFORE
--      INSERT trigger, de-duplicated to stay globally unique, and never
--      recomputed if the name later changes.
--   2. order_number_sequences — one counter row per (company, year). The app
--      bumps it atomically with INSERT ... ON CONFLICT DO UPDATE ... RETURNING,
--      so two concurrent order creations can never be handed the same value.
--      The counter resets each calendar year automatically because the year is
--      part of the key.
--   3. A UNIQUE index on orders(company_id, order_number) — a hard database
--      backstop so no duplicate business identifier can ever be stored, from
--      any source (auto-generated or client-supplied).
--
-- order_number_sequences is a server-only bookkeeping table: the client never
-- touches it (all client data flows through the API), so it is intentionally
-- not surfaced to the Data API. Follow the project's existing public-schema
-- RLS posture if that ever changes.
--
-- Idempotent: safe to re-run.
-- ================================================================

BEGIN;

-- ---------------------------------------------------------------
-- 1. companies.tenant_code
-- ---------------------------------------------------------------
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS tenant_code TEXT;

-- The *base* tenant code: first three A-Z letters of the name, upper-cased,
-- with every non-letter stripped first; 'ORD' when the name has no usable
-- letters. Immutable and kept in one place so the trigger and the backfill
-- agree exactly. SQL twin of deriveTenantCodeBase() in src/common/tenant-code.ts.
CREATE OR REPLACE FUNCTION public.tenant_code_base(company_name TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(
    NULLIF(UPPER(LEFT(REGEXP_REPLACE(COALESCE(company_name, ''), '[^A-Za-z]', '', 'g'), 3)), ''),
    'ORD'
  );
$$;

-- Return a globally-unique tenant code for a name: the base code, or the base
-- with the smallest numeric suffix that isn't taken yet (ABC, ABC2, ABC3, ...).
-- A transaction-scoped advisory lock keyed on the base serialises concurrent
-- inserts that share a base so the "find the next free suffix" scan cannot race
-- another insert; the UNIQUE constraint below is the final backstop.
CREATE OR REPLACE FUNCTION public.next_tenant_code(company_name TEXT)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  base      TEXT := public.tenant_code_base(company_name);
  candidate TEXT;
  n         INT  := 1;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('companies.tenant_code:' || base));
  candidate := base;
  WHILE EXISTS (SELECT 1 FROM public.companies WHERE tenant_code = candidate) LOOP
    n := n + 1;
    candidate := base || n::text;
  END LOOP;
  RETURN candidate;
END;
$$;

-- Populate tenant_code on tenant creation. Respects an explicitly-supplied
-- code; otherwise derives and de-duplicates one. Fires BEFORE INSERT so the
-- value is present on the very first write and the app never has to set it.
CREATE OR REPLACE FUNCTION public.companies_assign_tenant_code()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_code IS NULL OR NEW.tenant_code = '' THEN
    NEW.tenant_code := public.next_tenant_code(NEW.name);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_companies_assign_tenant_code ON public.companies;
CREATE TRIGGER trg_companies_assign_tenant_code
  BEFORE INSERT ON public.companies
  FOR EACH ROW
  EXECUTE FUNCTION public.companies_assign_tenant_code();

-- Backfill every existing tenant exactly once (NULLs only, so re-runs are
-- no-ops). Ordered by primary key for deterministic assignment: the first
-- company keeps the bare code, later collisions take the numeric suffix.
DO $$
DECLARE
  comp RECORD;
BEGIN
  FOR comp IN
    SELECT company_id, name
    FROM public.companies
    WHERE tenant_code IS NULL
    ORDER BY company_id
  LOOP
    UPDATE public.companies
    SET tenant_code = public.next_tenant_code(comp.name)
    WHERE company_id = comp.company_id;
  END LOOP;
END $$;

-- Every row now has a value: lock the invariant in.
ALTER TABLE public.companies
  ALTER COLUMN tenant_code SET NOT NULL;

ALTER TABLE public.companies
  DROP CONSTRAINT IF EXISTS uq_companies_tenant_code;
ALTER TABLE public.companies
  ADD CONSTRAINT uq_companies_tenant_code UNIQUE (tenant_code);

-- ---------------------------------------------------------------
-- 2. order_number_sequences — atomic per-tenant, per-year counter
-- ---------------------------------------------------------------
-- last_value is the highest sequence handed out so far for (company_id, year).
-- The app increments it with:
--   INSERT INTO order_number_sequences (company_id, year, last_value)
--   VALUES ($1, $2, 1)
--   ON CONFLICT (company_id, year)
--   DO UPDATE SET last_value = order_number_sequences.last_value + 1
--   RETURNING last_value;
-- The ON CONFLICT path takes a row lock, which is what makes concurrent order
-- creation for one (tenant, year) safe. A brand-new year has no row yet, so its
-- first order starts at 1.
CREATE TABLE IF NOT EXISTS public.order_number_sequences (
  company_id UUID    NOT NULL REFERENCES public.companies(company_id) ON DELETE CASCADE,
  year       INTEGER NOT NULL,
  last_value BIGINT  NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, year)
);

-- ---------------------------------------------------------------
-- 3. Hard uniqueness backstop for the business identifier
-- ---------------------------------------------------------------
-- Per-company uniqueness has always been enforced in application code; this
-- turns it into a database guarantee (and defends the atomic generator against
-- any client-supplied override). NOTE: if this index fails to build, pre-existing
-- duplicate order_numbers exist for some company and must be reconciled first.
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_company_order_number
  ON public.orders (company_id, order_number);

COMMIT;
