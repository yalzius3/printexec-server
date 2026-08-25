-- Make the vendor filament catalogues global, and keep them that way.
--
-- The reference catalogue is global BY DESIGN. Nothing in the read path filters
-- it by tenant: AssetsService.listFilamentReferences takes a companyId only to
-- compute that company's `usage_count`, and the row set it returns is the whole
-- table. A tenant-authored reference is even stamped source_type='global_custom'
-- to say out loud that contributing a reference publishes it.
--
-- The two local-vendor catalogues (Patron 3D, LynX) are seeded by
--   migrations/2026-07-22_patron_filament_catalog.sql   (75 rows)
--   migrations/2026-08-16_lynx_filament_catalog.sql     (52 rows)
-- both of which insert company_id = NULL. But a row can also reach this table
-- through POST /assets/filament-references, and older builds of that endpoint
-- stamped the creating tenant onto company_id rather than leaving it NULL. Such
-- a row still READS globally today — but it is one WHERE clause away from
-- becoming tenant-private, and it is the reason the catalogue *looks*
-- tenant-owned when you inspect the table.
--
-- This migration is the belt to the seeds' braces:
--   1. every Patron 3D / LynX row becomes company_id = NULL (globally owned)
--   2. re-running it changes nothing
--
-- What it deliberately does NOT touch:
--   * created_by_company_id — provenance, not ownership. It records which
--     tenant contributed a row to the shared catalogue and is read by nothing.
--     Nulling it would destroy that evidence to fix a field that isn't broken.
--   * source_type — a hand-added 'global_custom' row is not retroactively a
--     vendor datasheet just because the brand matches. Leave the label honest.
--   * printer_reference — same shape, same global read path, but out of scope
--     here. Check it separately if printers ever show the same symptom.
--
-- Run AFTER the two seed migrations (order does not actually matter — this is
-- idempotent either way — but running it last means it also catches anything
-- the seeds inserted).
--
-- Verify:
--   GET /api/health/schema  ->  catalog.filament_reference.vendor_catalogs_global
-- or:
--   SELECT brand, count(*) AS rows,
--          count(*) FILTER (WHERE company_id IS NULL) AS global_rows
--     FROM filament_reference
--    WHERE brand IN ('Patron 3D', 'LynX')
--    GROUP BY brand;
--   Expected: LynX 52 | 52 and Patron 3D 75 | 75.

BEGIN;

DO $promote$
DECLARE
  v_promoted int;
BEGIN
  UPDATE filament_reference
     SET company_id = NULL
   WHERE brand IN ('Patron 3D', 'LynX')
     AND company_id IS NOT NULL;

  GET DIAGNOSTICS v_promoted = ROW_COUNT;

  RAISE NOTICE 'Vendor catalogues: % tenant-scoped reference(s) promoted to global.',
    v_promoted;
END
$promote$;

COMMIT;
