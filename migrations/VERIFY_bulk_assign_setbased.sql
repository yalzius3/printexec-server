-- ================================================================
-- BULK ASSIGN — SET-BASED REWRITE, DIFFERENTIAL GATE
--
-- READ-ONLY in effect. Paste this ENTIRE file into the Supabase SQL editor and
-- Run. It returns ONE row with ONE jsonb column. Copy that whole value back.
--
-- WHY THIS EXISTS
-- simple-jobs.service.ts assign() used to write the batch as one UPDATE per
-- (nozzle, tank, minutes, grams) GROUP, and to seed multicolor slots with a
-- COUNT plus one UPDATE per slot per piece. Both are now single statements.
-- Nothing about the DECISIONS changed — but they were transcribed by hand from
-- one SQL dialect of the rule to another, and a swapped parameter there writes
-- a wrong status onto real work. So this compares the old expressions against
-- the new ones over every combination of inputs that can reach them.
--
-- Any key ending _pass that reads false is a real problem:
--   A_pass  the status CASE decides identically  (wrong = pieces land in the
--           wrong state, and 'ready' is what lets a piece be scheduled)
--   B_pass  the nozzle / tank SET expressions decide identically  (wrong =
--           stale tooling on the other technology, the resin-lane bug again)
--   C_pass  multicolor slot seeding picks the same slots and values
--   D_pass  both statements parse and plan against the live schema
--
-- Sections A–C touch no table at all. Section D is the two PREPARE statements
-- below: PREPARE parses and analyses a statement against the live schema
-- WITHOUT executing it, so every column, cast and clause is checked and no row
-- is read or written. A syntax or column error there aborts the whole run with
-- the real message — which is the point. Reaching the final SELECT means both
-- statements are valid against this database.
-- ================================================================

-- ── D. The real statements, parsed against this schema. Never executed. ────

PREPARE px_assign_setbased (uuid, uuid[], uuid, uuid[], int[], numeric[], uuid[], numeric[], boolean[]) AS
UPDATE order_pieces op
   SET assigned_printer_id = $3,
       assigned_nozzle_asset_id = CASE
         WHEN s.is_resin THEN NULL
         ELSE COALESCE(s.nozzle, op.assigned_nozzle_asset_id)
       END,
       resin_tank_id = CASE
         WHEN s.is_resin THEN COALESCE(s.tank, op.resin_tank_id)
         ELSE NULL
       END,
       slicer_file_url            = NULL,
       slicer_file_uploaded_at    = NULL,
       slicer_print_time_minutes  = s.minutes,
       slicer_filament_used_grams = s.grams,
       slicer_resin_used_ml       = s.ml,
       status = CASE
         WHEN op.required_print_technology IN ('MSLA', 'SLA') THEN
           CASE
             WHEN s.minutes IS NOT NULL AND s.ml IS NOT NULL
              AND COALESCE(s.tank, op.resin_tank_id) IS NOT NULL THEN 'ready'
             ELSE 'assigned'
           END
         WHEN COALESCE(s.nozzle, op.assigned_nozzle_asset_id) IS NOT NULL
          AND s.minutes IS NOT NULL AND s.grams IS NOT NULL THEN 'ready'
         WHEN COALESCE(s.nozzle, op.assigned_nozzle_asset_id) IS NOT NULL THEN 'assigned'
         ELSE op.status
       END
  FROM unnest($2::uuid[], $4::uuid[], $5::int[], $6::numeric[], $7::uuid[], $8::numeric[], $9::boolean[])
    AS s(piece_id, nozzle, minutes, grams, tank, ml, is_resin)
 WHERE op.company_id = $1
   AND op.piece_id = s.piece_id;

DEALLOCATE px_assign_setbased;

PREPARE px_slot_seed (uuid, uuid[], int[], numeric[]) AS
WITH seed AS (
  SELECT * FROM unnest($2::uuid[], $3::int[], $4::numeric[])
    AS t(piece_id, seq, grams)
),
have AS (
  SELECT piece_id, COUNT(*) AS n
    FROM order_piece_color_slots
   WHERE company_id = $1 AND piece_id = ANY($2::uuid[])
   GROUP BY piece_id
),
want AS (
  SELECT piece_id, COUNT(*) AS n FROM seed GROUP BY piece_id
),
eligible AS (
  SELECT h.piece_id FROM have h JOIN want w ON w.piece_id = h.piece_id AND w.n = h.n
),
ordered AS (
  SELECT color_slot_id, piece_id,
         ROW_NUMBER() OVER (PARTITION BY piece_id ORDER BY sequence_order) AS rn
    FROM order_piece_color_slots
   WHERE company_id = $1 AND piece_id IN (SELECT piece_id FROM eligible)
)
UPDATE order_piece_color_slots cs
   SET slicer_grams = seed.grams
  FROM ordered o
  JOIN seed ON seed.piece_id = o.piece_id AND seed.seq = o.rn
 WHERE cs.company_id = $1
   AND cs.color_slot_id = o.color_slot_id
   AND cs.slicer_grams IS NULL;

DEALLOCATE px_slot_seed;

-- ── A, B, C. Pure expression differentials — no table touched. ────────────

WITH

-- ── A + B. Every input combination the write can see ──────────────────────
--
-- 8 booleans, 256 rows. Columns prefixed row_ are the piece as it stands in the
-- table (what op.* reads); columns prefixed p_ are what the batch supplies for
-- that piece (what $4..$9 were, and what s.* is now).
matrix AS (
  SELECT
    tech.v            AS row_tech,
    row_noz.v         AS row_nozzle,
    row_tank.v        AS row_tank,
    'pending'::text   AS row_status,
    p_noz.v           AS p_nozzle,
    p_tank.v          AS p_tank,
    p_min.v           AS p_minutes,
    p_gram.v          AS p_grams,
    p_ml.v            AS p_ml,
    (tech.v IN ('MSLA','SLA')) AS p_is_resin
  FROM (VALUES ('FDM'),('MSLA'),('SLA'),(NULL)) AS tech(v)
  CROSS JOIN (VALUES ('11111111-1111-1111-1111-111111111111'::uuid),(NULL)) AS row_noz(v)
  CROSS JOIN (VALUES ('22222222-2222-2222-2222-222222222222'::uuid),(NULL)) AS row_tank(v)
  CROSS JOIN (VALUES ('33333333-3333-3333-3333-333333333333'::uuid),(NULL)) AS p_noz(v)
  CROSS JOIN (VALUES ('44444444-4444-4444-4444-444444444444'::uuid),(NULL)) AS p_tank(v)
  CROSS JOIN (VALUES (120::int),(NULL)) AS p_min(v)
  CROSS JOIN (VALUES (35.5::numeric),(NULL)) AS p_gram(v)
  CROSS JOIN (VALUES (80.0::numeric),(NULL)) AS p_ml(v)
),

-- The OLD expressions, transcribed from the group-loop UPDATE as it stood.
-- $4 = g.nozzle, $5 = g.minutes, $6 = g.grams, $7 = g.tank, $8 = g.ml,
-- $9 = g.isResin; unprefixed column names were the piece's own row.
old_side AS (
  SELECT m.*,
    CASE
      WHEN p_is_resin THEN NULL
      ELSE COALESCE(p_nozzle, row_nozzle)
    END AS old_nozzle_out,
    CASE
      WHEN p_is_resin THEN COALESCE(p_tank, row_tank)
      ELSE NULL
    END AS old_tank_out,
    CASE
      WHEN row_tech IN ('MSLA', 'SLA') THEN
        CASE
          WHEN p_minutes IS NOT NULL AND p_ml IS NOT NULL
           AND COALESCE(p_tank, row_tank) IS NOT NULL THEN 'ready'
          ELSE 'assigned'
        END
      WHEN COALESCE(p_nozzle, row_nozzle) IS NOT NULL
       AND p_minutes IS NOT NULL AND p_grams IS NOT NULL THEN 'ready'
      WHEN COALESCE(p_nozzle, row_nozzle) IS NOT NULL THEN 'assigned'
      ELSE row_status
    END AS old_status_out
  FROM matrix m
),

-- The NEW expressions, transcribed from the unnest() UPDATE as shipped.
-- s.* is the per-piece row from unnest; op.* is the piece's own row.
new_side AS (
  SELECT o.*,
    CASE
      WHEN p_is_resin THEN NULL
      ELSE COALESCE(p_nozzle, row_nozzle)
    END AS new_nozzle_out,
    CASE
      WHEN p_is_resin THEN COALESCE(p_tank, row_tank)
      ELSE NULL
    END AS new_tank_out,
    CASE
      WHEN row_tech IN ('MSLA', 'SLA') THEN
        CASE
          WHEN p_minutes IS NOT NULL AND p_ml IS NOT NULL
           AND COALESCE(p_tank, row_tank) IS NOT NULL THEN 'ready'
          ELSE 'assigned'
        END
      WHEN COALESCE(p_nozzle, row_nozzle) IS NOT NULL
       AND p_minutes IS NOT NULL AND p_grams IS NOT NULL THEN 'ready'
      WHEN COALESCE(p_nozzle, row_nozzle) IS NOT NULL THEN 'assigned'
      ELSE row_status
    END AS new_status_out
  FROM old_side o
),

ab AS (
  SELECT
    COUNT(*) AS combinations,
    COUNT(*) FILTER (WHERE old_status_out IS DISTINCT FROM new_status_out) AS status_diffs,
    COUNT(*) FILTER (WHERE old_nozzle_out IS DISTINCT FROM new_nozzle_out) AS nozzle_diffs,
    COUNT(*) FILTER (WHERE old_tank_out   IS DISTINCT FROM new_tank_out)   AS tank_diffs,
    -- Sanity: the matrix must actually exercise every outcome, or "no diffs"
    -- would only mean the test never reached the interesting branches.
    COUNT(*) FILTER (WHERE new_status_out = 'ready')    AS reached_ready,
    COUNT(*) FILTER (WHERE new_status_out = 'assigned') AS reached_assigned,
    COUNT(*) FILTER (WHERE new_status_out = 'pending')  AS reached_unchanged
  FROM new_side
),

-- ── C. Multicolor slot seeding ────────────────────────────────────────────
--
-- Synthetic slots and seeds, no table touched. Three pieces on purpose:
--   piece A — 3 slots, 3 figures, all unset      → all three seeded
--   piece B — 2 slots, 3 figures (quote disagrees with the piece) → skipped
--             WHOLE, which is what `if (count !== grams.length) continue` did
--   piece C — 3 slots, middle one already set    → only the unset two seeded
fake_slots AS (
  SELECT * FROM (VALUES
    ('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'a'::text, 1, NULL::numeric),
    ('aaaaaaaa-0000-0000-0000-000000000002'::uuid, 'a',       2, NULL),
    ('aaaaaaaa-0000-0000-0000-000000000003'::uuid, 'a',       3, NULL),
    ('bbbbbbbb-0000-0000-0000-000000000001'::uuid, 'b',       1, NULL),
    ('bbbbbbbb-0000-0000-0000-000000000002'::uuid, 'b',       2, NULL),
    ('cccccccc-0000-0000-0000-000000000001'::uuid, 'c',       1, NULL),
    ('cccccccc-0000-0000-0000-000000000002'::uuid, 'c',       2, 99.0),
    ('cccccccc-0000-0000-0000-000000000003'::uuid, 'c',       3, NULL)
  ) AS t(color_slot_id, piece_key, sequence_order, slicer_grams)
),
fake_seed AS (
  SELECT * FROM (VALUES
    ('a'::text, 1, 10.0::numeric), ('a', 2, 20.0), ('a', 3, 30.0),
    ('b', 1, 11.0), ('b', 2, 22.0), ('b', 3, 33.0),
    ('c', 1, 12.0), ('c', 2, 24.0), ('c', 3, 36.0)
  ) AS t(piece_key, seq, grams)
),
-- The OLD loop's outcome, stated declaratively: seed slot rn of piece p with
-- figure rn, but only when that piece's slot count equals its figure count,
-- and only where slicer_grams IS NULL.
c_old AS (
  SELECT s.color_slot_id, f.grams
    FROM (SELECT color_slot_id, piece_key, slicer_grams,
                 ROW_NUMBER() OVER (PARTITION BY piece_key ORDER BY sequence_order) AS rn
            FROM fake_slots) s
    JOIN fake_seed f ON f.piece_key = s.piece_key AND f.seq = s.rn
   WHERE s.slicer_grams IS NULL
     AND (SELECT COUNT(*) FROM fake_slots x WHERE x.piece_key = s.piece_key)
       = (SELECT COUNT(*) FROM fake_seed y WHERE y.piece_key = s.piece_key)
),
-- The NEW statement's CTE chain, run over the same fixture.
c_have AS (SELECT piece_key, COUNT(*) AS n FROM fake_slots GROUP BY piece_key),
c_want AS (SELECT piece_key, COUNT(*) AS n FROM fake_seed  GROUP BY piece_key),
c_eligible AS (
  SELECT h.piece_key FROM c_have h JOIN c_want w ON w.piece_key = h.piece_key AND w.n = h.n
),
c_ordered AS (
  SELECT color_slot_id, piece_key, slicer_grams,
         ROW_NUMBER() OVER (PARTITION BY piece_key ORDER BY sequence_order) AS rn
    FROM fake_slots
   WHERE piece_key IN (SELECT piece_key FROM c_eligible)
),
c_new AS (
  SELECT o.color_slot_id, f.grams
    FROM c_ordered o
    JOIN fake_seed f ON f.piece_key = o.piece_key AND f.seq = o.rn
   WHERE o.slicer_grams IS NULL
),
c AS (
  SELECT
    (SELECT COUNT(*) FROM c_old) AS old_writes,
    (SELECT COUNT(*) FROM c_new) AS new_writes,
    (SELECT COUNT(*) FROM (
       SELECT color_slot_id, grams FROM c_old
       EXCEPT ALL
       SELECT color_slot_id, grams FROM c_new) d) AS only_old,
    (SELECT COUNT(*) FROM (
       SELECT color_slot_id, grams FROM c_new
       EXCEPT ALL
       SELECT color_slot_id, grams FROM c_old) d) AS only_new,
    -- The fixture must actually exercise the two exclusions, or matching
    -- counts would prove nothing.
    (SELECT COUNT(*) FROM c_new WHERE color_slot_id::text LIKE 'bbbbbbbb%') AS wrote_mismatched_piece,
    (SELECT COUNT(*) FROM c_new WHERE color_slot_id = 'cccccccc-0000-0000-0000-000000000002'::uuid) AS overwrote_set_slot
),

-- D is the two PREPARE statements at the top of this file. If either failed to
-- parse against the live schema the run aborted there and this SELECT never
-- happened — so simply reaching it is the pass.
d_probe AS (SELECT true AS prepared_ok)

SELECT jsonb_pretty(jsonb_build_object(
  'A_combinations',        ab.combinations,
  'A_status_diffs',        ab.status_diffs,
  'A_reached_ready',       ab.reached_ready,
  'A_reached_assigned',    ab.reached_assigned,
  'A_reached_unchanged',   ab.reached_unchanged,
  'A_pass',                (ab.status_diffs = 0
                            AND ab.reached_ready > 0
                            AND ab.reached_assigned > 0
                            AND ab.reached_unchanged > 0),

  'B_nozzle_diffs',        ab.nozzle_diffs,
  'B_tank_diffs',          ab.tank_diffs,
  'B_pass',                (ab.nozzle_diffs = 0 AND ab.tank_diffs = 0),

  'C_old_writes',          c.old_writes,
  'C_new_writes',          c.new_writes,
  'C_only_old',            c.only_old,
  'C_only_new',            c.only_new,
  'C_wrote_mismatched',    c.wrote_mismatched_piece,
  'C_overwrote_set_slot',  c.overwrote_set_slot,
  'C_pass',                (c.only_old = 0 AND c.only_new = 0
                            AND c.wrote_mismatched_piece = 0
                            AND c.overwrote_set_slot = 0
                            AND c.new_writes = 5),

  'D_pass',                d.prepared_ok
)) AS result
FROM ab, c, d_probe d;
