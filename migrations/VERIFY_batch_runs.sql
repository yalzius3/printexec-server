-- ================================================================
-- BATCH RUNS — DID THE MIGRATION LAND, AND IS THE SHAPE RIGHT?
--
-- READ-ONLY. Paste this ENTIRE file into the Supabase SQL editor and Run.
-- It returns ONE row with ONE jsonb column. Copy that whole value back.
--
-- WHY THIS EXISTS
-- 2026-08-21_batch_runs.sql is the one migration the auto-schedule work needs,
-- and the code FAILS OPEN without it: a missing table makes big fleet packs run
-- inline exactly as they used to, with no progress bar and no Stop button, and
-- says so only in a server log line nobody is watching. That is the right
-- failure mode and it is also a silent one — so "did it actually apply?" cannot
-- be answered by using the app.
--
-- Every _pass that reads false is a real problem:
--   A_pass  the table exists AND the code's own probe finds it. The probe is
--           unqualified (to_regclass('batch_runs')), so it resolves through
--           search_path; a table sitting in a schema search_path does not reach
--           is invisible to the running API even though it exists.
--   B_pass  all three CHECK constraints are present. They are what stop a
--           progress write corrupting a run's state mid-commit.
--   C_pass  both indexes are present — the tenant listing and the partial index
--           the boot sweep uses.
--   D_pass  the company FK cascades, so deleting a company cannot strand rows.
--   E_pass  no run is stuck. A 'running' row with a stale heartbeat means a
--           process died without the boot sweep catching it, which after a
--           restart should be impossible.
-- ================================================================

WITH

-- ── A. Presence, both ways: literally, and the way the code asks ──────────
presence AS (
  SELECT
    (to_regclass('public.batch_runs') IS NOT NULL) AS qualified_exists,
    -- Exactly the expression RunsService.available() runs through
    -- run-store.runsTableExists(). If this is false while the line above is
    -- true, the table is real but the API cannot see it.
    (to_regclass('batch_runs') IS NOT NULL)        AS probe_finds_it
),

-- ── B. The constraints that keep a run's state honest ─────────────────────
cons AS (
  SELECT
    COUNT(*) FILTER (WHERE conname = 'chk_batch_runs_status')   AS has_status,
    COUNT(*) FILTER (WHERE conname = 'chk_batch_runs_counts')   AS has_counts,
    COUNT(*) FILTER (WHERE conname = 'chk_batch_runs_finished') AS has_finished,
    COUNT(*) FILTER (WHERE contype = 'f')                       AS foreign_keys
  FROM pg_constraint
  WHERE conrelid = to_regclass('public.batch_runs')
),

-- ── C. The two access paths the migration creates ─────────────────────────
idx AS (
  SELECT
    COUNT(*) FILTER (WHERE indexname = 'idx_batch_runs_company_created') AS has_company_created,
    COUNT(*) FILTER (WHERE indexname = 'idx_batch_runs_running')         AS has_running
  FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'batch_runs'
),

-- ── D. The company FK, and that it cascades ───────────────────────────────
fk AS (
  SELECT COUNT(*) AS cascading_company_fk
  FROM pg_constraint
  WHERE conrelid = to_regclass('public.batch_runs')
    AND contype = 'f'
    AND confdeltype = 'c'          -- 'c' = ON DELETE CASCADE
),

-- ── E. Operational state. Cheap, and the only part that can change. ───────
--
-- A 'running' row whose heartbeat is older than the sweep's two-minute
-- threshold belongs to a process that is gone. After any restart there should
-- be none: the boot sweep marks them failed. One sitting here means either the
-- sweep did not run or the API has not restarted since the process died.
-- Read through query_to_xml, and NOT because anyone enjoys that. A plain
-- `FROM batch_runs` is resolved when the statement is PARSED, so if the table
-- is missing the whole script dies with "relation does not exist" and reports
-- nothing — losing sections A to D in exactly the case they exist to describe.
-- query_to_xml takes its query as a STRING, so it is not resolved until it
-- runs, and CASE short-circuits, so it never runs when the table is absent.
state AS (
  SELECT CASE
    WHEN to_regclass('public.batch_runs') IS NULL THEN NULL
    ELSE (xpath(
      '/table/row/j/text()',
      query_to_xml(
        $q$SELECT jsonb_build_object(
             'runs_total',      COUNT(*),
             'running_now',     COUNT(*) FILTER (WHERE status = 'running'),
             'stuck',           COUNT(*) FILTER (WHERE status = 'running'
                                                   AND heartbeat_at < now() - interval '2 minutes'),
             'failed_total',    COUNT(*) FILTER (WHERE status = 'failed'),
             'cancelled_total', COUNT(*) FILTER (WHERE status = 'cancelled'),
             'newest_run_at',   MAX(created_at)::text
           ) AS j FROM public.batch_runs$q$,
        false, false, ''
      )
    ))[1]::text::jsonb
  END AS s
)

SELECT jsonb_pretty(jsonb_build_object(
  'A_table_exists',        p.qualified_exists,
  'A_code_probe_finds_it', p.probe_finds_it,
  'A_pass',                (p.qualified_exists AND p.probe_finds_it),

  'B_has_status_check',    (c.has_status = 1),
  'B_has_counts_check',    (c.has_counts = 1),
  'B_has_finished_check',  (c.has_finished = 1),
  'B_pass',                (c.has_status = 1 AND c.has_counts = 1 AND c.has_finished = 1),

  'C_has_company_index',   (i.has_company_created = 1),
  'C_has_running_index',   (i.has_running = 1),
  'C_pass',                (i.has_company_created = 1 AND i.has_running = 1),

  'D_cascading_fk',        f.cascading_company_fk,
  'D_pass',                (f.cascading_company_fk = 1),

  'E_runs_total',          (s.s ->> 'runs_total'),
  'E_running_now',         (s.s ->> 'running_now'),
  'E_stuck',               (s.s ->> 'stuck'),
  'E_failed_total',        (s.s ->> 'failed_total'),
  'E_cancelled_total',     (s.s ->> 'cancelled_total'),
  'E_newest_run_at',       (s.s ->> 'newest_run_at'),
  -- Null when the table is absent: A_pass already says that, and E has nothing
  -- to report about a table that is not there.
  'E_pass',                (s.s IS NULL OR (s.s ->> 'stuck')::int = 0)
)) AS result
FROM presence p, cons c, idx i, fk f, state s;
