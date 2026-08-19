-- ================================================================
-- JOBS QUEUE READ PATH -- two missing access paths
--
-- Both come out of the 10k-piece audit of GET /api/jobs/queue (JobsService
-- .listJobs -> jobSelectSql). Neither changes behaviour; each gives an existing
-- query an index it currently does without.
--
-- 1. order_pieces (company_id, created_at DESC)
--    listJobs ends `ORDER BY op.created_at DESC` under `WHERE op.company_id =
--    $1`. The surviving composite from 2026-07-09_perf_indexes.sql is
--    (company_id, status), which cannot supply created_at order across statuses
--    -- and "all statuses" is the queue's DEFAULT filter. So the common case
--    sorts the tenant's whole piece set with no access path.
--
--    NOT added: (company_id, status, created_at DESC) for the status-filtered
--    case. It would supersede idx_order_pieces_company_status, but that is a
--    swap-and-drop on the hottest table in the system and wants pg_stat_user_
--    indexes evidence from real traffic first. Two indexes where one may do is
--    write amplification -- see 2026-07-09_index_dedupe.sql for the standing
--    rule. Left as a deliberate follow-up, not an oversight.
--
-- 2. order_piece_color_slots (piece_id)
--    jobSelectSql carries a CORRELATED json_agg subquery over this table,
--    evaluated once per projected row. With an index that is a cheap probe per
--    row; without one it is a scan of the whole table per row. The queue reads
--    ~10k rows for a large tenant, so the difference is the whole query.
--
-- ── DUPLICATE GUARD ─────────────────────────────────────────────────────────
-- Deliberately NOT plain `CREATE INDEX IF NOT EXISTS`. That checks the NAME
-- only, and this schema is known to carry base indexes that are not defined in
-- this repo -- 2026-07-09_index_dedupe.sql exists precisely because the live
-- database turned out to hold overlapping ones (idx_pieces_order,
-- idx_order_pieces_schedule_window, idx_pieces_status, ...). Creating a
-- same-columns index under a new name would be pure write amplification on the
-- hottest table in the system.
--
-- So each block checks pg_index for an index whose LEADING column(s) already
-- cover the access path, and creates nothing if one exists. Both blocks also
-- guard the table with to_regclass, matching the house style.
--
-- Idempotent, and safe to re-run.
--
-- ⚠ LOCKING -- READ BEFORE APPLYING TO PRODUCTION
-- scripts/run-sql-file.mjs sends this file as ONE implicit transaction, so
-- CREATE INDEX CONCURRENTLY is illegal inside it (same constraint documented in
-- 2026-07-09_perf_indexes.sql). A plain CREATE INDEX takes a SHARE lock on the
-- table: SELECTs keep working, but every INSERT/UPDATE/DELETE on order_pieces
-- BLOCKS until the build finishes. On a small table that is sub-second. On a
-- table grown into the millions of pieces it is a write stall on the shop floor
-- -- no operator can advance a job while it runs.
--
-- If order_pieces is already large, do NOT run this file through db:run-file.
-- Run each statement by hand, outside a transaction, with CONCURRENTLY:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_order_pieces_company_created
--     ON public.order_pieces (company_id, created_at DESC);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_order_piece_color_slots_piece
--     ON public.order_piece_color_slots (piece_id);
--
-- (CONCURRENTLY does not block writes. It can leave an INVALID index if it
-- fails -- check `SELECT * FROM pg_index WHERE NOT indisvalid` afterwards and
-- DROP + retry any it left behind.) Check the size first:
--   SELECT reltuples::bigint AS approx_rows FROM pg_class
--    WHERE oid = 'public.order_pieces'::regclass;
--
-- ── VERIFY FIRST (read-only) ────────────────────────────────────────────────
-- This file's guards were written against the catalog documentation but could
-- not be executed anywhere before shipping (no local Postgres, no .env in the
-- repo). Run this first: it prints what already exists and how big the table is,
-- which answers both "is either index redundant?" and "do I need CONCURRENTLY?".
--
--   SELECT c.relname AS index_name,
--          pg_get_indexdef(i.indexrelid)      AS definition,
--          i.indisunique, i.indpred IS NOT NULL AS is_partial
--     FROM pg_index i
--     JOIN pg_class c ON c.oid = i.indexrelid
--    WHERE i.indrelid IN ('public.order_pieces'::regclass,
--                         'public.order_piece_color_slots'::regclass)
--    ORDER BY c.relname;
--
--   SELECT relname, reltuples::bigint AS approx_rows
--     FROM pg_class
--    WHERE oid IN ('public.order_pieces'::regclass,
--                  'public.order_piece_color_slots'::regclass);
--
-- If either index already exists in an equivalent form, the DO blocks below will
-- say so via RAISE NOTICE and create nothing.
--
-- Rollback:
--   DROP INDEX IF EXISTS idx_order_pieces_company_created;
--   DROP INDEX IF EXISTS idx_order_piece_color_slots_piece;
-- ================================================================

BEGIN;

-- -- 1. order_pieces (company_id, created_at DESC) -------------------
DO $$
DECLARE
  col_company int2;
  col_created int2;
  already     boolean;
BEGIN
  IF to_regclass('public.order_pieces') IS NULL THEN
    RAISE NOTICE 'order_pieces missing -- skipping';
    RETURN;
  END IF;

  SELECT a.attnum INTO col_company FROM pg_attribute a
   WHERE a.attrelid = 'public.order_pieces'::regclass AND a.attname = 'company_id';
  SELECT a.attnum INTO col_created FROM pg_attribute a
   WHERE a.attrelid = 'public.order_pieces'::regclass AND a.attname = 'created_at';

  IF col_company IS NULL OR col_created IS NULL THEN
    RAISE NOTICE 'order_pieces.company_id/created_at missing -- skipping';
    RETURN;
  END IF;

  -- Any index already leading (company_id, created_at) serves this ORDER BY,
  -- whatever it happens to be named.
  --
  -- indkey is read via string_to_array(indkey::text) rather than subscripted
  -- directly: indkey is an int2vector whose subscripts are 0-based, unlike every
  -- normal Postgres array, and casts/slices of it have changed behaviour across
  -- versions. Rendering to text and splitting gives a plain text[] with the
  -- standard lower bound of 1, so the ordinals here are unambiguous on any
  -- server. Getting that wrong would silently either skip a needed index or
  -- create a duplicate on the hottest table in the schema.
  --
  -- indnkeyatts (PG 11+; Supabase is well past it) excludes INCLUDE columns, so
  -- an index like (company_id) INCLUDE (created_at) -- which cannot supply
  -- ordering -- is correctly NOT treated as a match.
  SELECT EXISTS (
    SELECT 1
      FROM pg_index i
     WHERE i.indrelid = 'public.order_pieces'::regclass
       AND i.indnkeyatts >= 2
       AND i.indpred IS NULL          -- a partial index can't serve every read
       AND (string_to_array(i.indkey::text, ' '))[1]::int = col_company
       AND (string_to_array(i.indkey::text, ' '))[2]::int = col_created
  ) INTO already;

  IF already THEN
    RAISE NOTICE 'order_pieces already has a (company_id, created_at ...) index -- skipping';
  ELSE
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_order_pieces_company_created
               ON public.order_pieces (company_id, created_at DESC)';
  END IF;
END $$;

-- -- 2. order_piece_color_slots (piece_id) ---------------------------
DO $$
DECLARE
  col_piece int2;
  already   boolean;
BEGIN
  IF to_regclass('public.order_piece_color_slots') IS NULL THEN
    RAISE NOTICE 'order_piece_color_slots missing -- skipping';
    RETURN;
  END IF;

  SELECT a.attnum INTO col_piece FROM pg_attribute a
   WHERE a.attrelid = 'public.order_piece_color_slots'::regclass
     AND a.attname = 'piece_id';

  IF col_piece IS NULL THEN
    RAISE NOTICE 'order_piece_color_slots.piece_id missing -- skipping';
    RETURN;
  END IF;

  -- Leading piece_id is enough: the subquery filters on piece_id alone. A
  -- UNIQUE (piece_id, sequence_order) would already cover it, exactly as
  -- uq_piece_spool_asset covers order_piece_spools (see index_dedupe).
  -- Same string_to_array reading of indkey as above, and for the same reason.
  SELECT EXISTS (
    SELECT 1
      FROM pg_index i
     WHERE i.indrelid = 'public.order_piece_color_slots'::regclass
       AND i.indnkeyatts >= 1
       AND i.indpred IS NULL
       AND (string_to_array(i.indkey::text, ' '))[1]::int = col_piece
  ) INTO already;

  IF already THEN
    RAISE NOTICE 'order_piece_color_slots already has a leading-piece_id index -- skipping';
  ELSE
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_order_piece_color_slots_piece
               ON public.order_piece_color_slots (piece_id)';
  END IF;
END $$;

COMMIT;
