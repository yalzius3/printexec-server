-- ================================================================
-- Metadata-driven readiness.
--
-- ⚠ SUPERSEDED: the new constraints below omitted the `OR (bed_id IS NOT NULL)`
-- escape that the sibling status constraints carry, which breaks bed
-- scheduling. Apply 2026-07-01_readiness_bed_escape_fix.sql, which re-adds both
-- constraints correctly (with the bed escape) and validates them. On a fresh
-- database, run this file first, then the fix.
--
-- "Ready" / "scheduled" / "printing" pieces (and beds) were gated at the DB
-- level on the SLICER FILE (slicer_file_url) via:
--     chk_ready_requires_core_data
--     chk_scheduled_requires_core_data
-- The slicer file is just an optional attachment — the system never feeds it
-- to a printer — so readiness should be gated on the slicer METADATA instead:
-- an assigned printer + nozzle and both slicer print time + filament grams
-- (which may come from a parsed file, a parsed header, or manual entry).
--
-- This migration drops the file-gated constraints and re-creates them gated on
-- the metadata. New constraints are added NOT VALID so any pre-existing rows
-- that don't satisfy the tighter rule don't block the migration; every INSERT
-- and UPDATE from now on is enforced. VALIDATE them later (see step 3) once any
-- legacy rows are reconciled.
--
-- BEFORE APPLYING: run `npm run db:show-slicer-constraints` and confirm:
--   (a) the exact current definitions below match (esp. chk_scheduled — if it
--       carries extra conditions beyond printer/nozzle/file/time, fold them in);
--   (b) the violating-row counts are acceptable (or you've reconciled them).
--
-- Idempotent: safe to re-run (drop-if-references + add-if-not-exists pattern).
-- ================================================================

BEGIN;

-- ── 1) Drop the old file-gated constraints on BOTH tables, name-independently.
-- Matches any CHECK constraint referencing slicer_file_url, so it captures
-- chk_ready_requires_core_data, chk_scheduled_requires_core_data, and any bed
-- analogues regardless of their exact names.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT conrelid::regclass AS tbl, conname
    FROM pg_constraint
    WHERE contype = 'c'
      AND conrelid IN ('public.order_pieces'::regclass, 'public.print_beds'::regclass)
      AND pg_get_constraintdef(oid) ILIKE '%slicer_file_url%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
    RAISE NOTICE 'Dropped constraint %.%', r.tbl, r.conname;
  END LOOP;
END $$;

-- ── 2) Re-create readiness constraints gated on slicer METADATA.
-- order_pieces: 'ready' needs printer + nozzle + time + grams.
ALTER TABLE public.order_pieces
  DROP CONSTRAINT IF EXISTS chk_ready_requires_core_data;
ALTER TABLE public.order_pieces
  ADD CONSTRAINT chk_ready_requires_core_data
  CHECK (
    status <> 'ready'
    OR (assigned_printer_id IS NOT NULL
        AND assigned_nozzle_asset_id IS NOT NULL
        AND slicer_print_time_minutes IS NOT NULL
        AND slicer_filament_used_grams IS NOT NULL)
  ) NOT VALID;

-- order_pieces: 'scheduled'/'printing' need the same core data.
ALTER TABLE public.order_pieces
  DROP CONSTRAINT IF EXISTS chk_scheduled_requires_core_data;
ALTER TABLE public.order_pieces
  ADD CONSTRAINT chk_scheduled_requires_core_data
  CHECK (
    status NOT IN ('scheduled', 'printing')
    OR (assigned_printer_id IS NOT NULL
        AND assigned_nozzle_asset_id IS NOT NULL
        AND slicer_print_time_minutes IS NOT NULL
        AND slicer_filament_used_grams IS NOT NULL)
  ) NOT VALID;

-- print_beds: only re-add equivalents if this table actually had file-gated
-- readiness constraints (i.e. step 1 dropped something here). If your
-- introspection shows print_beds had NO such constraints, leave this block
-- commented — bed readiness is enforced in the application layer.
--
-- ALTER TABLE public.print_beds
--   DROP CONSTRAINT IF EXISTS chk_ready_requires_core_data;
-- ALTER TABLE public.print_beds
--   ADD CONSTRAINT chk_ready_requires_core_data
--   CHECK (
--     status <> 'ready'
--     OR (assigned_printer_id IS NOT NULL
--         AND assigned_nozzle_asset_id IS NOT NULL
--         AND slicer_print_time_minutes IS NOT NULL
--         AND slicer_filament_used_grams IS NOT NULL)
--   ) NOT VALID;
-- ALTER TABLE public.print_beds
--   DROP CONSTRAINT IF EXISTS chk_scheduled_requires_core_data;
-- ALTER TABLE public.print_beds
--   ADD CONSTRAINT chk_scheduled_requires_core_data
--   CHECK (
--     status NOT IN ('scheduled', 'printing')
--     OR (assigned_printer_id IS NOT NULL
--         AND assigned_nozzle_asset_id IS NOT NULL
--         AND slicer_print_time_minutes IS NOT NULL
--         AND slicer_filament_used_grams IS NOT NULL)
--   ) NOT VALID;

COMMIT;

-- ── 3) After confirming there are no violating rows (see
-- scripts/show-slicer-constraints.mjs), promote the constraints to fully
-- validated:
--
-- ALTER TABLE public.order_pieces VALIDATE CONSTRAINT chk_ready_requires_core_data;
-- ALTER TABLE public.order_pieces VALIDATE CONSTRAINT chk_scheduled_requires_core_data;
