-- ================================================================
-- STORAGE KEY INDEXES -- the access path for "is this file still referenced?"
--
-- Every delete path now asks StorageFilesService.unreferencedKeys() one
-- question before removing any bytes: does ANY row anywhere still point at this
-- object? It has to be asked, and it has to be answered exactly -- duplicatePiece
-- copies slicer_file_url onto every duplicate, so one object key can belong to
-- twenty live pieces, and deleting the source piece must not take their G-code
-- with it.
--
-- Without these indexes that question costs a sequential scan of every
-- file-bearing table, every time. The delete paths already batch (one check per
-- operation, never one per row), so it is one scan set per bulk delete rather
-- than 500 -- survivable, but it grows with the tenant and it is on the path of
-- an interactive action.
--
-- ── WHY AN EXPRESSION INDEX AND NOT A PLAIN ONE ─────────────────────────────
-- The query derives the KEY from the stored URL rather than reconstructing the
-- URL from the key:
--
--   split_part(split_part(slicer_file_url, '/uploads/', 2), '?', 1) = $key
--
-- Reconstruction would be indexable with a plain b-tree on the column, and it
-- was rejected: it has to GUESS which form the URL was stored in
-- ("/api/uploads/...", legacy "/uploads/...", an absolute URL, one carrying a
-- query string), and a guess that misses reports a live file as unreferenced.
-- That fails OPEN, in the single direction that destroys customer data.
-- Extraction cannot miss, so extraction is what the code does -- and this file
-- gives it the index it needs to be cheap.
--
-- The expression here must stay byte-identical to KEY_EXPR in
-- src/storage/storage-files.service.ts. If they drift, the index is silently
-- not used and the reference check quietly returns to full scans; it stays
-- CORRECT, it just stops being fast. Change one, change both.
--
-- (split_part is IMMUTABLE, which is what makes it indexable. If a future
-- Postgres disagrees, CREATE INDEX fails loudly at apply time and nothing is
-- left half-built -- a safe failure, not a silent one.)
--
-- Partial on IS NOT NULL: most pieces carry no STL and no thumbnail, so the
-- index only covers the rows that can ever match.
--
-- companies.logo_url is deliberately NOT indexed. One row per tenant makes a
-- scan cheaper than an index probe, and it will stay that way.
--
-- Idempotent and safe to re-run. Every block guards on the table AND the column
-- existing, so a database that has not run 2026-07-04_piece_stl_thumbnail.sql
-- (or the beds migrations) skips that index instead of erroring -- matching the
-- house to_regclass style.
--
-- ⚠ LOCKING -- READ BEFORE APPLYING TO PRODUCTION
-- scripts/run-sql-file.mjs sends this file as ONE implicit transaction, so
-- CREATE INDEX CONCURRENTLY is illegal inside it (same constraint documented in
-- 2026-07-09_perf_indexes.sql and 2026-08-17_jobs_queue_read_indexes.sql). A
-- plain CREATE INDEX takes a SHARE lock: SELECTs keep working, every
-- INSERT/UPDATE/DELETE on the table BLOCKS until the build finishes. Sub-second
-- on a small table; a write stall on the shop floor on a large one.
--
-- Check the size first:
--   SELECT relname, reltuples::bigint AS approx_rows
--     FROM pg_class
--    WHERE oid IN ('public.order_pieces'::regclass,
--                  'public.print_beds'::regclass,
--                  'public.order_attachments'::regclass);
--
-- If order_pieces is already large, do NOT run this file through db:run-file.
-- Run these by hand instead, one at a time, outside any transaction:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_order_pieces_slicer_key
--     ON public.order_pieces ((split_part(split_part(slicer_file_url, '/uploads/', 2), '?', 1)))
--     WHERE slicer_file_url IS NOT NULL;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_order_pieces_stl_key
--     ON public.order_pieces ((split_part(split_part(stl_file_url, '/uploads/', 2), '?', 1)))
--     WHERE stl_file_url IS NOT NULL;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_order_pieces_thumb_key
--     ON public.order_pieces ((split_part(split_part(stl_thumbnail_url, '/uploads/', 2), '?', 1)))
--     WHERE stl_thumbnail_url IS NOT NULL;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_print_beds_slicer_key
--     ON public.print_beds ((split_part(split_part(slicer_file_url, '/uploads/', 2), '?', 1)))
--     WHERE slicer_file_url IS NOT NULL;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_print_beds_stl_key
--     ON public.print_beds ((split_part(split_part(stl_file_url, '/uploads/', 2), '?', 1)))
--     WHERE stl_file_url IS NOT NULL;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_order_attachments_file_key
--     ON public.order_attachments ((split_part(split_part(file_url, '/uploads/', 2), '?', 1)))
--     WHERE file_url IS NOT NULL;
--
-- (CONCURRENTLY can leave an INVALID index if it fails -- check
--  `SELECT * FROM pg_index WHERE NOT indisvalid` afterwards and DROP + retry.)
--
-- NOTHING BREAKS IF THIS FILE IS NEVER APPLIED. The reference check is correct
-- without it; it is only slower. This is a performance migration, not a
-- correctness one -- deliberately, so the delete-path fix can ship first.
--
-- Rollback:
--   DROP INDEX IF EXISTS idx_order_pieces_slicer_key;
--   DROP INDEX IF EXISTS idx_order_pieces_stl_key;
--   DROP INDEX IF EXISTS idx_order_pieces_thumb_key;
--   DROP INDEX IF EXISTS idx_print_beds_slicer_key;
--   DROP INDEX IF EXISTS idx_print_beds_stl_key;
--   DROP INDEX IF EXISTS idx_order_attachments_file_key;
-- ================================================================

BEGIN;

DO $$
DECLARE
  spec RECORD;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('order_pieces',      'slicer_file_url',    'idx_order_pieces_slicer_key'),
      ('order_pieces',      'stl_file_url',       'idx_order_pieces_stl_key'),
      ('order_pieces',      'stl_thumbnail_url',  'idx_order_pieces_thumb_key'),
      ('print_beds',        'slicer_file_url',    'idx_print_beds_slicer_key'),
      ('print_beds',        'stl_file_url',       'idx_print_beds_stl_key'),
      ('order_attachments', 'file_url',           'idx_order_attachments_file_key')
    ) AS v(tbl, col, idx)
  LOOP
    -- Table missing entirely (a deploy that predates it) -> nothing to index.
    IF to_regclass('public.' || spec.tbl) IS NULL THEN
      RAISE NOTICE 'skip %.% -- table does not exist', spec.tbl, spec.col;
      CONTINUE;
    END IF;

    -- Column missing (its migration has not run) -> no row can reference a
    -- file through it, so there is nothing for the reference check to probe.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = spec.tbl
         AND column_name = spec.col
    ) THEN
      RAISE NOTICE 'skip %.% -- column does not exist', spec.tbl, spec.col;
      CONTINUE;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = spec.idx) THEN
      RAISE NOTICE 'skip % -- already exists', spec.idx;
      CONTINUE;
    END IF;

    RAISE NOTICE 'creating % on %.%', spec.idx, spec.tbl, spec.col;
    EXECUTE format(
      'CREATE INDEX %I ON public.%I ((split_part(split_part(%I, ''/uploads/'', 2), ''?'', 1))) WHERE %I IS NOT NULL',
      spec.idx, spec.tbl, spec.col, spec.col
    );
  END LOOP;
END $$;

COMMIT;
