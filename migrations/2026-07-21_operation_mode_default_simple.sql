-- ================================================================
-- OPERATION MODE DEFAULT → 'simple'
-- Advanced mode is fully retired from the product. New companies are
-- already stamped 'simple' by the signup path (auth.controller), but the
-- companies.operation_mode column default still read 'advanced' from the
-- original 2026-06-17_operation_mode.sql. Flip the default so ANY future
-- insert path is Simple by default too — belt-and-suspenders.
--
-- Additive + idempotent: only the column DEFAULT changes. Existing rows are
-- left exactly as they are (the client now runs the Simple UX regardless of a
-- company's stored mode, so a legacy 'advanced' stamp is inert). Safe to re-run.
-- ================================================================

BEGIN;

ALTER TABLE public.companies
  ALTER COLUMN operation_mode SET DEFAULT 'simple';

COMMIT;
