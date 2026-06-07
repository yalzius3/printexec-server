-- ================================================================
-- AUTH MIGRATION: company_memberships + schema extension
-- Safe to re-run: all steps are idempotent
-- ================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────
-- STEP 1: Add companies_owned, companies_joined to public.users
-- ────────────────────────────────────────────────────────────────
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS companies_owned  UUID[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS companies_joined UUID[] NOT NULL DEFAULT '{}';

-- ────────────────────────────────────────────────────────────────
-- STEP 2: Add new columns to public.companies
-- SKIPPED (already exist): phone, address, country_code, owner_user_id
-- NOTE: 'address' exists as a single column; address_line_1/2 are new.
-- ────────────────────────────────────────────────────────────────
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS city                 TEXT,
  ADD COLUMN IF NOT EXISTS address_line_1       TEXT,
  ADD COLUMN IF NOT EXISTS address_line_2       TEXT,
  ADD COLUMN IF NOT EXISTS postal_code          TEXT,
  ADD COLUMN IF NOT EXISTS website              TEXT,
  ADD COLUMN IF NOT EXISTS industry             TEXT,
  ADD COLUMN IF NOT EXISTS company_size         TEXT,
  ADD COLUMN IF NOT EXISTS tax_id               TEXT,
  ADD COLUMN IF NOT EXISTS currency_default     TEXT,
  ADD COLUMN IF NOT EXISTS timezone             TEXT,
  ADD COLUMN IF NOT EXISTS owner_wrkxyz_id      UUID,
  ADD COLUMN IF NOT EXISTS owner_display_name   TEXT,
  ADD COLUMN IF NOT EXISTS owner_email          TEXT,
  ADD COLUMN IF NOT EXISTS onboarded_at         TIMESTAMPTZ;

-- CHECK constraint for company_size — add only if not already present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'companies_company_size_check'
      AND conrelid = 'public.companies'::regclass
  ) THEN
    ALTER TABLE public.companies
      ADD CONSTRAINT companies_company_size_check
        CHECK (company_size IN ('solo', '2-10', '11-50', '51-200', '200+'));
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────
-- STEP 3: CREATE TABLE company_memberships
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.company_memberships (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         UUID        NOT NULL
                                 REFERENCES public.companies(company_id)
                                 ON DELETE CASCADE,
  wrkxyz_account_id  UUID        NOT NULL
                                 REFERENCES auth.users(id)
                                 ON DELETE CASCADE,
  role               TEXT        NOT NULL
                                 CHECK (role IN ('owner', 'staff')),
  permissions        JSONB       NOT NULL DEFAULT '{}',
  joined_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  invited_by         UUID
                                 REFERENCES auth.users(id)
                                 ON DELETE SET NULL,
  UNIQUE (company_id, wrkxyz_account_id)
);

-- ────────────────────────────────────────────────────────────────
-- STEP 4: Partial unique index — one owner per company
-- ────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS one_owner_per_company
  ON public.company_memberships (company_id)
  WHERE role = 'owner';

-- ────────────────────────────────────────────────────────────────
-- STEP 5: Backfill company_memberships from existing public.users
-- joined_at = users.created_at so timestamps are historically accurate
-- ON CONFLICT DO NOTHING makes this re-runnable
-- ────────────────────────────────────────────────────────────────
INSERT INTO public.company_memberships
  (company_id, wrkxyz_account_id, role, permissions, joined_at)
SELECT
  u.company_id,
  u.id,
  u.role,
  u.permissions,
  u.created_at
FROM public.users u
ON CONFLICT (company_id, wrkxyz_account_id) DO NOTHING;

-- ────────────────────────────────────────────────────────────────
-- STEP 6: Backfill companies_owned / companies_joined on users
-- Guard on = '{}' makes this idempotent on re-run
-- ────────────────────────────────────────────────────────────────
UPDATE public.users
SET companies_owned = ARRAY[company_id]
WHERE role = 'owner'
  AND companies_owned = '{}';

UPDATE public.users
SET companies_joined = ARRAY[company_id]
WHERE role = 'staff'
  AND companies_joined = '{}';

-- ────────────────────────────────────────────────────────────────
-- STEP 7: Add created_at to company_invites (RF-5)
-- ────────────────────────────────────────────────────────────────
ALTER TABLE public.company_invites
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- ────────────────────────────────────────────────────────────────
-- STEP 8: RLS + grants for company_memberships
-- Same pattern as all 17 existing policies.
-- Backend bypasses RLS; this is defense-in-depth for PostgREST.
-- ────────────────────────────────────────────────────────────────
ALTER TABLE public.company_memberships ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'company_memberships'
      AND policyname = 'rls_company_memberships'
  ) THEN
    CREATE POLICY "rls_company_memberships"
      ON public.company_memberships FOR ALL
      USING (company_id = get_my_company_id());
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.company_memberships TO authenticated;

COMMIT;
