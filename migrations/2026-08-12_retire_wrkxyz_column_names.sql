-- ================================================================
-- Retire the legacy "WRKXYZ" parent-brand name from the schema.
--
--   company_memberships.wrkxyz_account_id  ->  account_id
--   companies.owner_wrkxyz_id              ->  owner_account_id
--
-- WRKXYZ was an earlier internal parent-brand name. It is retired;
-- PrintExec is a product of ProArt Consulting. These two columns were
-- the last structural references to it.
--
-- Scope of the rename (audited 2026-08-12, whole codebase):
--   · src/auth/auth.controller.ts        — 4 sites
--   · src/licensing/company-purge.service.ts — 5 sites
--   · NO views, functions, triggers or RLS policies reference either
--     column. rls_company_memberships keys on company_id only, and
--     the one_owner_per_company index is on company_id alone, so both
--     are unaffected.
--   · The UNIQUE (company_id, wrkxyz_account_id) constraint and the
--     FK to auth.users follow the column automatically, but the
--     auto-generated CONSTRAINT NAME still contains "wrkxyz", so it is
--     renamed explicitly below.
--
-- ⚠️  THIS IS A HARD CUTOVER. ALTER ... RENAME COLUMN removes the old
--     name immediately. An API instance still running the old code will
--     throw on signup / invite-accept / company-purge the moment this
--     lands. Apply this migration and deploy the API together, in this
--     order, in a low-traffic window:
--
--       1. apply this migration   (npm run db:run-file)
--       2. deploy the API         (Railway deploy, not a restart)
--
-- Idempotent: every step is guarded on the old name still existing, so
-- re-running after a successful apply is a no-op.
-- ================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────
-- STEP 1: company_memberships.wrkxyz_account_id -> account_id
-- ────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'company_memberships'
      AND column_name  = 'wrkxyz_account_id'
  ) THEN
    ALTER TABLE public.company_memberships
      RENAME COLUMN wrkxyz_account_id TO account_id;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────
-- STEP 2: companies.owner_wrkxyz_id -> owner_account_id
-- ────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'companies'
      AND column_name  = 'owner_wrkxyz_id'
  ) THEN
    ALTER TABLE public.companies
      RENAME COLUMN owner_wrkxyz_id TO owner_account_id;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────
-- STEP 3: Rename the auto-generated UNIQUE constraint.
-- Postgres carried it through the column rename, but its NAME was
-- derived from the old column and still reads "…_wrkxyz_account_id_key".
-- Renaming it keeps \d output and any future ON CONFLICT ON CONSTRAINT
-- free of the retired brand.
-- ────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'company_memberships_company_id_wrkxyz_account_id_key'
  ) THEN
    ALTER TABLE public.company_memberships
      RENAME CONSTRAINT company_memberships_company_id_wrkxyz_account_id_key
                     TO company_memberships_company_id_account_id_key;
  END IF;
END $$;

COMMIT;

-- ────────────────────────────────────────────────────────────────
-- Verification (run after apply — both should return the NEW names):
--
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'company_memberships' AND column_name LIKE '%account%';
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'companies' AND column_name LIKE '%owner%';
--   SELECT conname FROM pg_constraint
--    WHERE conrelid = 'public.company_memberships'::regclass;
-- ────────────────────────────────────────────────────────────────
