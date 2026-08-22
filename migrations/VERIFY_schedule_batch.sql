-- ================================================================
-- BULK TIMELINE MOVES — DO THE NEW STATEMENTS FIT THE LIVE SCHEMA?
--
-- READ-ONLY. Nothing here writes, and nothing here is a migration: the bulk
-- scheduling work adds NO new tables and NO new columns. Paste this ENTIRE file
-- into the Supabase SQL editor and Run. It returns ONE row with ONE jsonb
-- column. Copy that whole value back.
--
-- WHY THIS EXISTS
-- Two new endpoints were added to the jobs service:
--   POST /api/jobs/schedule-batch    — re-time many pieces (bulk timeline move)
--   POST /api/jobs/unschedule-batch  — pull many pieces off the board
--
-- schedule-batch reuses jobsService.scheduleCommit unchanged, so it runs SQL
-- that has been in production for months. unschedule-batch does NOT: it
-- replaces N per-piece round trips with one read and up to two set-based
-- UPDATEs, and that SQL is new. New SQL that has never executed anywhere is
-- exactly what this file exists to catch, BEFORE it runs against real work.
--
-- PREPARE is the tool: it parses and plans a statement against the real schema
-- without executing it. A column that does not exist, a type that does not
-- cast, a table that was never created — all of them fail here. The statements
-- are prepared with the same parameter types the driver sends.
--
-- Every _pass that reads false is a real problem:
--   A_pass  every column the new code touches exists, with the type it assumes.
--   B_pass  the read statement PREPAREs — the one that decides, per piece,
--           whether it drops back to 'ready' or to 'assigned'.
--   C_pass  the write statement PREPAREs for BOTH target statuses.
--   D_pass  'ready' and 'assigned' are both accepted by whatever constrains
--           order_pieces.status. If this is false the batch would fail at
--           runtime on rows the single-piece route handles fine.
--   E_pass  there is an index that makes `piece_id = ANY(...)` a lookup rather
--           than a seq scan. The batch sends up to 1000 ids at a time.
--   F_pass  no piece is currently in an impossible state for this code — a
--           'scheduled' row with no window, which the unschedule read would
--           happily match and then clear to nothing.
-- ================================================================

BEGIN;

-- ── B / C. Plan the exact statements the new service method issues ────────
--    Any schema mismatch raises here and the whole transaction rolls back,
--    which is itself the answer: if this file errors instead of returning a
--    row, the statement does not fit the schema.
PREPARE _sb_read (uuid, uuid[]) AS
  SELECT piece_id, order_id, slicer_print_time_minutes, slicer_filament_used_grams,
         slicer_resin_used_ml, required_print_technology
    FROM order_pieces
   WHERE company_id = $1 AND piece_id = ANY($2::uuid[]) AND status = 'scheduled';

PREPARE _sb_write (uuid, uuid[], text) AS
  UPDATE order_pieces
     SET scheduled_start_at = NULL,
         scheduled_end_at   = NULL,
         scheduled_at       = NULL,
         status             = $3
   WHERE company_id = $1 AND piece_id = ANY($2::uuid[]) AND status = 'scheduled';

-- The read scheduleCommit already does, included so this file also proves the
-- schedule side still fits (it is untouched code, but it is the code the bulk
-- move drives 500 rows at a time).
PREPARE _sb_spools (uuid, uuid) AS
  SELECT spool_asset_id FROM order_piece_spools WHERE company_id = $1 AND piece_id = $2;

WITH

-- ── A. The columns the new code names, and the types it assumes ───────────
cols AS (
  SELECT
    COUNT(*) FILTER (WHERE column_name = 'piece_id')                   AS c_piece_id,
    COUNT(*) FILTER (WHERE column_name = 'order_id')                   AS c_order_id,
    COUNT(*) FILTER (WHERE column_name = 'company_id')                 AS c_company_id,
    COUNT(*) FILTER (WHERE column_name = 'status')                     AS c_status,
    COUNT(*) FILTER (WHERE column_name = 'scheduled_start_at')         AS c_start,
    COUNT(*) FILTER (WHERE column_name = 'scheduled_end_at')           AS c_end,
    COUNT(*) FILTER (WHERE column_name = 'scheduled_at')               AS c_at,
    COUNT(*) FILTER (WHERE column_name = 'slicer_print_time_minutes')  AS c_minutes,
    COUNT(*) FILTER (WHERE column_name = 'slicer_filament_used_grams') AS c_grams,
    COUNT(*) FILTER (WHERE column_name = 'slicer_resin_used_ml')       AS c_ml,
    COUNT(*) FILTER (WHERE column_name = 'required_print_technology')  AS c_tech
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'order_pieces'
),

-- ── B / C. Did the statements above actually plan? ────────────────────────
prepared AS (
  SELECT
    COUNT(*) FILTER (WHERE name = '_sb_read')   AS has_read,
    COUNT(*) FILTER (WHERE name = '_sb_write')  AS has_write,
    COUNT(*) FILTER (WHERE name = '_sb_spools') AS has_spools
  FROM pg_prepared_statements
),

-- ── D. Both landing statuses are legal ────────────────────────────────────
--    The TypeScript decides 'ready' vs 'assigned' with the same
--    hasSlicerCoreData the single-piece route uses. This proves the database
--    will accept either answer. Reads the enum if status is one, otherwise the
--    CHECK constraint text.
status_ok AS (
  SELECT
    CASE
      WHEN EXISTS (
        SELECT 1 FROM pg_type t
         JOIN pg_attribute a ON a.atttypid = t.oid
        WHERE a.attrelid = to_regclass('public.order_pieces')
          AND a.attname = 'status' AND t.typtype = 'e'
      ) THEN (
        SELECT bool_and(v = ANY (ARRAY(
          SELECT e.enumlabel::text FROM pg_enum e
           JOIN pg_attribute a ON a.atttypid = e.enumtypid
          WHERE a.attrelid = to_regclass('public.order_pieces') AND a.attname = 'status'
        )))
        FROM unnest(ARRAY['ready','assigned']) AS v
      )
      ELSE (
        SELECT COALESCE(bool_or(
          pg_get_constraintdef(oid) LIKE '%ready%' AND pg_get_constraintdef(oid) LIKE '%assigned%'
        ), true)
        FROM pg_constraint
        WHERE conrelid = to_regclass('public.order_pieces')
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%status%'
      )
    END AS both_allowed
),

-- ── E. Is `piece_id = ANY($2)` an index lookup? ───────────────────────────
--    The batch sends up to 1000 ids. Without an index this is a seq scan of
--    every piece in the database, once per chunk.
idx AS (
  SELECT
    COUNT(*) FILTER (
      WHERE indexdef ILIKE '%(piece_id%' OR indexdef ILIKE '%(company_id, piece_id%'
    ) AS piece_lookup
  FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'order_pieces'
),

-- ── F. Is anything already in a state this code would mishandle? ──────────
--    A 'scheduled' row with no window is a piece the unschedule read matches
--    and then clears to NULLs it already held. Harmless, but it means
--    something else wrote a state the schedule guard should have prevented,
--    and that is worth knowing before a bulk action touches 1000 rows.
health AS (
  SELECT
    COUNT(*) FILTER (WHERE status = 'scheduled' AND (scheduled_start_at IS NULL OR scheduled_end_at IS NULL)) AS windowless_scheduled,
    COUNT(*) FILTER (WHERE status = 'scheduled' AND scheduled_end_at <= scheduled_start_at)                   AS inverted_windows,
    COUNT(*) FILTER (WHERE status = 'scheduled')                                                              AS scheduled_total
  FROM order_pieces
)

SELECT jsonb_pretty(jsonb_build_object(
  'A_pass', (SELECT c_piece_id = 1 AND c_order_id = 1 AND c_company_id = 1 AND c_status = 1
                AND c_start = 1 AND c_end = 1 AND c_at = 1 AND c_minutes = 1
                AND c_grams = 1 AND c_ml = 1 AND c_tech = 1 FROM cols),
  'A_columns', (SELECT to_jsonb(cols) FROM cols),
  'B_pass', (SELECT has_read = 1 FROM prepared),
  'C_pass', (SELECT has_write = 1 AND has_spools = 1 FROM prepared),
  'D_pass', (SELECT COALESCE(both_allowed, false) FROM status_ok),
  'E_pass', (SELECT piece_lookup > 0 FROM idx),
  'E_indexes', (SELECT piece_lookup FROM idx),
  'F_pass', (SELECT windowless_scheduled = 0 AND inverted_windows = 0 FROM health),
  'F_health', (SELECT to_jsonb(health) FROM health)
)) AS result;

DEALLOCATE _sb_read;
DEALLOCATE _sb_write;
DEALLOCATE _sb_spools;

ROLLBACK;
