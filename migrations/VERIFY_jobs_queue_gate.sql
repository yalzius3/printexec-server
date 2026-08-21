-- ================================================================
-- JOBS QUEUE — PRE-PUSH GATE  (single query, nothing to select)
--
-- READ-ONLY. Paste this ENTIRE file into the Supabase SQL editor and Run.
-- It is ONE statement and returns ONE row with ONE jsonb column.
-- Copy that whole value back.
--
-- Any key ending _pass that reads false is a real problem. The two that
-- matter most:
--   B4_pass  the fingerprint DETECTS a change. False = boards can go stale
--            while prints start and finish, with nothing on screen to say so.
--   B6_pass  select-all cannot reach rows the operator cannot see. False =
--            a select-all + delete can remove invisible work.
--
-- Targets the biggest tenant automatically. To pin one, find-and-replace
--   (SELECT company_id FROM order_pieces GROUP BY company_id ORDER BY COUNT(*) DESC LIMIT 1)
-- with  '<your-uuid>'::uuid
-- ================================================================

WITH tenant AS (
  SELECT company_id FROM order_pieces GROUP BY company_id ORDER BY COUNT(*) DESC LIMIT 1
),

-- The fingerprint's per-row signature, exactly as shipped.
sig_rows AS (
  SELECT op.status,
         CONCAT_WS('|',
           op.piece_id::text, op.status,
           COALESCE(op.fulfilment_status,''), COALESCE(op.post_process_state,''),
           COALESCE(op.bed_id::text,''), COALESCE(op.assigned_printer_id::text,''),
           COALESCE(op.assigned_nozzle_asset_id::text,''), COALESCE(op.resin_tank_id::text,''),
           COALESCE(op.scheduled_start_at::text,''), COALESCE(op.scheduled_end_at::text,''),
           COALESCE(op.print_started_at::text,''), COALESCE(op.print_completed_at::text,''),
           COALESCE(op.slicer_print_time_minutes::text,''), COALESCE(op.piece_name,'')
         ) AS sig,
         ROW_NUMBER() OVER (ORDER BY op.piece_id) AS rn
    FROM order_pieces op
   WHERE op.company_id = (SELECT company_id FROM tenant)
),
-- The same set with ONE piece's status altered. Nothing is written.
mut_rows AS (
  SELECT CASE WHEN rn = 1 THEN replace(sig, '|' || status || '|', '|__changed__|')
              ELSE sig END AS sig
    FROM sig_rows
),
fp     AS (SELECT COUNT(*)::int AS n, md5(string_agg(sig, ',' ORDER BY sig)) AS d FROM sig_rows),
fp_mut AS (SELECT md5(string_agg(sig, ',' ORDER BY sig)) AS d FROM mut_rows),

-- The visible queue, and the ids select-all returns. Must be identical.
visible AS (
  SELECT op.piece_id
    FROM order_pieces op
    JOIN orders o          ON o.order_id = op.order_id AND o.company_id = op.company_id
    LEFT JOIN customers cu ON cu.customer_id = o.customer_id
   WHERE op.company_id = (SELECT company_id FROM tenant)
     AND op.bed_id IS NULL
     AND o.status IN ('confirmed','in_progress','completed','ready_for_shipping','out_for_shipping')
),
selectable AS (
  SELECT op.piece_id
    FROM order_pieces op
    JOIN orders o          ON o.order_id = op.order_id AND o.company_id = op.company_id
    LEFT JOIN customers cu ON cu.customer_id = o.customer_id
   WHERE op.company_id = (SELECT company_id FROM tenant)
     AND op.bed_id IS NULL
     AND o.status IN ('confirmed','in_progress','completed','ready_for_shipping','out_for_shipping')
),

-- The summary endpoint's aggregates.
scoped AS (
  SELECT op.status, op.fulfilment_status, op.post_process_state,
         op.required_print_technology, o.order_number,
         COALESCE(NULLIF(cu.business_name,''),
                  NULLIF(TRIM(CONCAT_WS(' ', cu.first_name, cu.last_name)),'')) AS customer_name
    FROM order_pieces op
    JOIN orders o          ON o.order_id = op.order_id AND o.company_id = op.company_id
    LEFT JOIN customers cu ON cu.customer_id = o.customer_id
   WHERE op.company_id = (SELECT company_id FROM tenant)
     AND op.bed_id IS NULL
     AND o.status IN ('confirmed','in_progress','completed','ready_for_shipping','out_for_shipping')
),
staged AS (
  SELECT CASE
           WHEN status <> 'done' THEN status
           WHEN post_process_state IS NOT NULL AND post_process_state <> 'cured' THEN post_process_state
           WHEN fulfilment_status  IS NOT NULL AND fulfilment_status  <> 'none'  THEN fulfilment_status
           ELSE 'done'
         END AS stage
    FROM scoped
),

-- Bulk-assign candidates.
assignable AS (
  SELECT op.piece_id, op.cost_inputs
    FROM order_pieces op
    JOIN orders o                   ON o.order_id = op.order_id AND o.company_id = op.company_id
    LEFT JOIN filament_reference fr ON fr.filament_ref_id = op.required_filament_ref_id
   WHERE op.company_id = (SELECT company_id FROM tenant)
     AND op.bed_id IS NULL
     AND op.status = 'pending'
     AND op.assigned_printer_id IS NULL
     AND o.status IN ('confirmed','in_progress','completed','ready_for_shipping','out_for_shipping')
),

-- Collation behaviour. Literals are cast to text explicitly: a bare VALUES
-- literal can still be `unknown`, and COLLATE on `unknown` is an error.
coll AS (
  SELECT string_agg(name, ',' ORDER BY lower(name) COLLATE "C" ASC, name COLLATE "C" DESC) AS case_order
    FROM (VALUES ('BRACKET'::text), ('bracket'::text), ('Bracket'::text)) v(name)
),
bytes AS (
  SELECT string_agg(ch, ',' ORDER BY ch COLLATE "C") AS byte_order
    FROM (VALUES ('a'::text), ('B'::text), ('_'::text), ('1'::text)) v(ch)
),

-- Urgency key magnitude vs float8's exact-integer ceiling (2^53).
urg AS (
  SELECT COALESCE(MAX(k), 0) AS max_key FROM (
    SELECT (CASE WHEN (EXTRACT(EPOCH FROM (o.deadline::timestamp AT TIME ZONE 'UTC')) * 1000
                       - EXTRACT(EPOCH FROM now()) * 1000) / 60000.0 < 0 THEN 0 ELSE 3 END)
           * 10000000000000::float8
           + EXTRACT(EPOCH FROM (o.deadline::timestamp AT TIME ZONE 'UTC')) * 1000 * 10 AS k
      FROM order_pieces op
      JOIN orders o ON o.order_id = op.order_id
     WHERE op.company_id = (SELECT company_id FROM tenant) AND o.deadline IS NOT NULL
  ) x
)

-- Built as one jsonb object, then EXPANDED INTO ROWS below. Returning it as a
-- single blob meant the results grid clipped the cell and showed 2 keys of 32.
, gate AS (
SELECT jsonb_build_object(

  'tenant',                 (SELECT company_id::text FROM tenant),
  'tenant_pieces',          (SELECT n FROM fp),

  -- ── A. assumptions the shipped code depends on ──────────────
  'A1_db_ctype',            (SELECT datctype::text FROM pg_database WHERE datname = current_database()),
  'A1_pass',                (SELECT (datctype NOT IN ('C','POSIX')) FROM pg_database WHERE datname = current_database()),
  'A2_lower_accented',      lower('ÉCROU'),
  'A2_pass',                (lower('ÉCROU') = 'écrou'),
  'A3_deadline_type',       (SELECT data_type::text FROM information_schema.columns
                              WHERE table_schema='public' AND table_name='orders' AND column_name='deadline'),
  'A3_pass',                (SELECT (data_type::text = 'date') FROM information_schema.columns
                              WHERE table_schema='public' AND table_name='orders' AND column_name='deadline'),
  'A4_utc_epoch_ms',        (EXTRACT(EPOCH FROM ('2026-08-17'::date::timestamp AT TIME ZONE 'UTC')) * 1000)::bigint,
  -- The constant is 2026-08-17T00:00:00Z, the same instant as the literal on
  -- the line above. It read 1755388800000 until 2026-08-21 -- exactly 365 days
  -- early, i.e. 2025-08-17 -- so this reported false on a database that was
  -- answering correctly. A gate that cries wolf is worse than no gate: the run
  -- that mattered was read as 'known failure, ignore it'.
  'A4_pass',                (EXTRACT(EPOCH FROM ('2026-08-17'::date::timestamp AT TIME ZONE 'UTC')) * 1000 = 1786924800000),
  'A5_trigger_count',       (SELECT COUNT(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                              WHERE NOT t.tgisinternal AND c.relname IN ('order_pieces','orders')),
  'A5_note',                'informational — 0 means last_updated_at is NOT maintained, which the fingerprint assumes',
  'A5b_server_timezone',    current_setting('TimeZone'),

  -- ── B. do the shipped queries run, and agree ────────────────
  'B3_fingerprint_digest',  (SELECT COALESCE(d,'-') FROM fp),
  'B3_pass',                (SELECT (d IS NULL OR length(d) = 32) FROM fp),
  'B4_digest_after_change', (SELECT COALESCE(d,'-') FROM fp_mut),
  'B4_pass',                (SELECT (SELECT d FROM fp) IS DISTINCT FROM (SELECT d FROM fp_mut)),
  'B5_visible_total',       (SELECT COUNT(*)::int FROM scoped),
  'B5_stage_counts',        (SELECT COALESCE(jsonb_object_agg(stage, n), '{}'::jsonb)
                               FROM (SELECT stage, COUNT(*)::int AS n FROM staged GROUP BY stage) g),
  'B5_facets',              (SELECT jsonb_build_object(
                                'orders',    COUNT(DISTINCT order_number),
                                'customers', COUNT(DISTINCT customer_name),
                                'techs',     COUNT(DISTINCT required_print_technology)) FROM scoped),
  'B6_ids_not_in_list',     (SELECT COUNT(*)::int FROM (SELECT piece_id FROM selectable
                                                        EXCEPT SELECT piece_id FROM visible) x),
  'B6_pass',                (SELECT COUNT(*) FROM (SELECT piece_id FROM selectable
                                                   EXCEPT SELECT piece_id FROM visible) x) = 0,
  'B6b_counts',             (SELECT COUNT(*)::text FROM selectable) || ' vs ' || (SELECT COUNT(*)::text FROM visible),
  'B6b_pass',               ((SELECT COUNT(*) FROM selectable) = (SELECT COUNT(*) FROM visible)),
  'B7_assignable_count',    (SELECT COUNT(*)::int FROM assignable),
  'B7_with_cost_inputs',    (SELECT COUNT(*)::int FROM assignable WHERE cost_inputs IS NOT NULL),

  -- ── C. the sort ─────────────────────────────────────────────
  'C1_case_order',          (SELECT case_order FROM coll),
  'C1_pass',                ((SELECT case_order FROM coll) = 'bracket,Bracket,BRACKET'),
  'C2_byte_order',          (SELECT byte_order FROM bytes),
  'C2_pass',                ((SELECT byte_order FROM bytes) = '1,B,_,a'),
  'C5_max_urgency_key',     (SELECT max_key::bigint FROM urg),
  'C5_pass',                (SELECT (max_key < 9007199254740992) FROM urg)

) AS obj
)
-- One row per check. Alphabetical on the prefixed keys happens to be the logical
-- order too (A… assumptions, B… shipped queries, C… the sort).
SELECT e.key AS check,
       e.value,
       CASE WHEN e.key LIKE '%\_pass' AND e.value = 'false'
            THEN '<<<<<< FAIL' ELSE '' END AS flag
  FROM gate g, jsonb_each_text(g.obj) e
 ORDER BY e.key;
