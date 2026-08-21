-- ================================================================
-- VERIFICATION SCRIPT — Jobs queue read path
--
-- READ-ONLY. Every statement is a SELECT or an EXPLAIN. Nothing is created,
-- altered, deleted or written. Safe against production.
--
-- NO SETUP NEEDED. Paste the whole file into the Supabase SQL editor and run.
-- There are no psql meta-commands (`\set`) and no bind parameters — an earlier
-- draft used those and they are not valid in the Supabase editor.
--
-- Every tenant-scoped query targets the BIGGEST tenant automatically, via this
-- exact expression, repeated verbatim throughout:
--
--     (SELECT company_id FROM order_pieces GROUP BY company_id
--       ORDER BY COUNT(*) DESC LIMIT 1)
--
-- TO PIN A SPECIFIC TENANT: find-and-replace that whole expression, including
-- its outer parentheses, with:  '<your-uuid>'::uuid
--
-- WHY THIS EXISTS
-- The queue's server-side sorting, fingerprint, facets, select-all ids and
-- bulk-assign candidates were all built WITHOUT a database available: no .env in
-- the repo, no local Postgres. The SQL has been reviewed line by line and its
-- SEMANTICS are covered by unit tests, but the SQL itself has never executed
-- anywhere. These checks close that gap.
--
-- ── WHEN TO RUN WHAT ────────────────────────────────────────────────────────
--
-- PHASE 1 — BEFORE PUSHING THE CODE (the gate).  A1 A2 A3 A4 · B3 B4 B5 B6 B7 · C1 C2 C5
--   Section B contains the SHIPPED queries. A wrong column name or bad cast is
--   not a slow page — it is a 500 on /jobs/queue, i.e. the Jobs board failing to
--   load. A3/A4 are blocking for a different reason: if `deadline` is not a
--   DATE, the urgency ordering is silently wrong for every user.
--
-- PHASE 2 — ALSO BEFORE PUSHING, AND ONLY POSSIBLE NOW.  C3 C4
--   Compare their output against what the Jobs queue displays TODAY with the
--   matching sort selected. The deployed app still orders rows on the client, so
--   this is a genuine old-vs-new comparison. After the push both sides are the
--   server and the test proves nothing. This window does not come back.
--
-- PHASE 3 — NOW THAT THE INDEX MIGRATION IS APPLIED.  B1 B2 · D1 D2 D3 D4
--   B1 was written as a pre-flight; it is now the confirmation. It shows whether
--   2026-08-17_jobs_queue_read_indexes.sql created its two indexes, or whether
--   its duplicate-guard found equivalents already present and skipped. Both are
--   correct outcomes, but they are different ones. D1/D2 then show whether the
--   planner actually uses them.
--
-- PHASE 4 — AFTER DEPLOY, optional.  A5 A6
--   Informational. If a last_updated_at trigger does exist, the fingerprint
--   could be made cheaper than the checksum it uses today. Nothing breaks.
-- ================================================================


-- ════════════════════════════════════════════════════════════════
-- A. ASSUMPTIONS THE CODE DEPENDS ON
-- ════════════════════════════════════════════════════════════════

-- A1. Database collation and ctype.
--     The queue's ORDER BY uses `lower(x) COLLATE "C"`. COLLATE "C" was chosen
--     so ordering does NOT depend on this — but lower() still uses the ctype. If
--     ctype is C or POSIX, lower() folds ASCII only, so "ÉCROU" will not sort
--     beside "écrou".
--     EXPECT: a UTF-8 ctype (e.g. en_US.utf8). If C/POSIX, tell me.
SELECT datname,
       pg_encoding_to_char(encoding) AS encoding,
       datcollate,
       datctype
  FROM pg_database
 WHERE datname = current_database();

-- A2. Does lower() actually fold non-ASCII here? The direct test of A1.
--     EXPECT: lower_accented = 'écrou', folds_non_ascii = true
SELECT lower('ÉCROU')           AS lower_accented,
       lower('قطعة')            AS lower_arabic,
       lower('ÉCROU') = 'écrou' AS folds_non_ascii;

-- A3. Is `orders.deadline` really a DATE?
--     The urgency sort converts it with AT TIME ZONE 'UTC' because the client
--     parses "YYYY-MM-DD" as UTC midnight. If this is timestamptz instead, that
--     conversion is wrong and every urgency bucket skews.
--     EXPECT: orders.deadline -> data_type = 'date'
SELECT table_name, column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name IN ('orders', 'order_pieces')
   AND column_name IN ('deadline', 'created_at', 'last_updated_at',
                       'post_process_state_entered_at')
 ORDER BY table_name, column_name;

-- A4. Does the UTC conversion produce the epoch the client computes?
--     Client: new Date('2026-08-17').getTime() === 1786924800000
--     EXPECT: matches_client = true
SELECT EXTRACT(EPOCH FROM ('2026-08-17'::date::timestamp AT TIME ZONE 'UTC')) * 1000
         AS epoch_ms,
       EXTRACT(EPOCH FROM ('2026-08-17'::date::timestamp AT TIME ZONE 'UTC')) * 1000
         = 1786924800000 AS matches_client,
       current_setting('TimeZone') AS server_timezone;

-- A5. Is `last_updated_at` maintained by a TRIGGER?
--     No code in this repo writes it (0 of 25 UPDATE statements), and the
--     time-state transitions certainly do not — which is why the fingerprint
--     deliberately does not use it. If this returns rows, a trigger exists and
--     a cheaper fingerprint becomes possible.
--     EXPECT: zero rows.
SELECT c.relname AS table_name,
       t.tgname  AS trigger_name,
       p.proname AS function_name,
       pg_get_triggerdef(t.oid) AS definition
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_proc  p ON p.oid = t.tgfoid
 WHERE NOT t.tgisinternal
   AND c.relname IN ('order_pieces', 'orders')
 ORDER BY c.relname, t.tgname;

-- A6. How stale is last_updated_at in practice?
--     EXPECT (if A5 is empty): equal_to_created ≈ the row count.
SELECT COUNT(*)                                            AS pieces,
       COUNT(*) FILTER (WHERE last_updated_at = created_at) AS equal_to_created,
       COUNT(*) FILTER (WHERE last_updated_at > created_at) AS actually_updated
  FROM order_pieces
 WHERE company_id = (SELECT company_id FROM order_pieces GROUP BY company_id
                      ORDER BY COUNT(*) DESC LIMIT 1);


-- ════════════════════════════════════════════════════════════════
-- B. DOES THE SHIPPED SQL RUN, AND IS IT SANE?
-- ════════════════════════════════════════════════════════════════

-- B1. Index inventory — CONFIRMS what the applied migration did.
--     LOOK FOR: idx_order_pieces_company_created and
--     idx_order_piece_color_slots_piece. If they are absent, the migration's
--     duplicate-guard found an equivalent access path already present and
--     skipped — check for any index leading (company_id, created_at) on
--     order_pieces, or leading piece_id on order_piece_color_slots.
SELECT c2.relname                    AS index_name,
       c.relname                     AS table_name,
       i.indisunique                 AS is_unique,
       i.indpred IS NOT NULL         AS is_partial,
       pg_get_indexdef(i.indexrelid) AS definition
  FROM pg_index i
  JOIN pg_class c  ON c.oid  = i.indrelid
  JOIN pg_class c2 ON c2.oid = i.indexrelid
 WHERE c.relname IN ('order_pieces', 'order_piece_color_slots', 'orders')
 ORDER BY c.relname, c2.relname;

-- B2. Table sizes.
SELECT relname AS table_name,
       reltuples::bigint AS approx_rows,
       pg_size_pretty(pg_total_relation_size(oid)) AS total_size
  FROM pg_class
 WHERE relname IN ('order_pieces', 'order_piece_color_slots', 'orders', 'print_beds')
 ORDER BY reltuples DESC;

-- B3. THE FINGERPRINT (GET /jobs/queue/fingerprint).
--     EXPECT: one row; n = every piece for the tenant INCLUDING bedded ones (the
--     digest is deliberately wider than the visible list); sig = 32 hex chars.
SELECT COUNT(*)::int AS n,
       COALESCE(md5(string_agg(sig, ',' ORDER BY sig)), '-') AS sig
  FROM (
    SELECT CONCAT_WS('|',
             op.piece_id::text,
             op.status,
             COALESCE(op.fulfilment_status, ''),
             COALESCE(op.post_process_state, ''),
             COALESCE(op.bed_id::text, ''),
             COALESCE(op.assigned_printer_id::text, ''),
             COALESCE(op.assigned_nozzle_asset_id::text, ''),
             COALESCE(op.resin_tank_id::text, ''),
             COALESCE(op.scheduled_start_at::text, ''),
             COALESCE(op.scheduled_end_at::text, ''),
             COALESCE(op.print_started_at::text, ''),
             COALESCE(op.print_completed_at::text, ''),
             COALESCE(op.slicer_print_time_minutes::text, ''),
             COALESCE(op.piece_name, '')
           ) AS sig
      FROM order_pieces op
     WHERE op.company_id = (SELECT company_id FROM order_pieces GROUP BY company_id
                             ORDER BY COUNT(*) DESC LIMIT 1)
  ) s;

-- B4. FINGERPRINT SENSITIVITY — the property the whole design rests on.
--     Recomputes the digest with ONE piece's status altered, writing nothing,
--     and asserts the digest moves. If these match, the poll is blind and boards
--     can go stale while prints start and finish.
--     EXPECT: digests_differ = true
WITH base AS (
  SELECT op.status,
         CONCAT_WS('|', op.piece_id::text, op.status,
           COALESCE(op.fulfilment_status,''), COALESCE(op.post_process_state,''),
           COALESCE(op.bed_id::text,''), COALESCE(op.assigned_printer_id::text,''),
           COALESCE(op.assigned_nozzle_asset_id::text,''), COALESCE(op.resin_tank_id::text,''),
           COALESCE(op.scheduled_start_at::text,''), COALESCE(op.scheduled_end_at::text,''),
           COALESCE(op.print_started_at::text,''), COALESCE(op.print_completed_at::text,''),
           COALESCE(op.slicer_print_time_minutes::text,''), COALESCE(op.piece_name,'')) AS sig,
         ROW_NUMBER() OVER (ORDER BY op.piece_id) AS rn
    FROM order_pieces op
   WHERE op.company_id = (SELECT company_id FROM order_pieces GROUP BY company_id
                           ORDER BY COUNT(*) DESC LIMIT 1)
),
mutated AS (
  SELECT CASE WHEN rn = 1
              THEN replace(sig, '|' || status || '|', '|__changed__|')
              ELSE sig END AS sig
    FROM base
)
SELECT (SELECT md5(string_agg(sig, ',' ORDER BY sig)) FROM base)    AS digest_now,
       (SELECT md5(string_agg(sig, ',' ORDER BY sig)) FROM mutated) AS digest_after_one_change,
       (SELECT md5(string_agg(sig, ',' ORDER BY sig)) FROM base)
         IS DISTINCT FROM
       (SELECT md5(string_agg(sig, ',' ORDER BY sig)) FROM mutated) AS digests_differ;

-- B5. THE SUMMARY (GET /jobs/queue/summary) — facets + stage tab counts.
WITH scoped AS (
  SELECT op.status, op.fulfilment_status, op.post_process_state,
         op.required_print_technology, o.order_number,
         COALESCE(NULLIF(cu.business_name,''),
                  NULLIF(TRIM(CONCAT_WS(' ', cu.first_name, cu.last_name)),'')) AS customer_name
    FROM order_pieces op
    JOIN orders o          ON o.order_id = op.order_id AND o.company_id = op.company_id
    LEFT JOIN customers cu ON cu.customer_id = o.customer_id
   WHERE op.company_id = (SELECT company_id FROM order_pieces GROUP BY company_id
                           ORDER BY COUNT(*) DESC LIMIT 1)
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
)
SELECT (SELECT COUNT(DISTINCT order_number)  FROM scoped) AS distinct_orders,
       (SELECT COUNT(DISTINCT customer_name) FROM scoped
         WHERE customer_name IS NOT NULL AND customer_name <> '') AS distinct_customers,
       (SELECT COUNT(DISTINCT required_print_technology) FROM scoped
         WHERE required_print_technology IS NOT NULL) AS distinct_techs,
       (SELECT COALESCE(json_object_agg(stage, n), '{}'::json)
          FROM (SELECT stage, COUNT(*)::int AS n FROM staged GROUP BY stage) g) AS stage_counts,
       (SELECT COUNT(*)::int FROM scoped) AS total;

-- B6. SELECT-ALL ids vs the LIST — these MUST agree exactly.
--     THE MOST IMPORTANT CHECK HERE: these ids feed bulk delete. If ids_count
--     exceeds list_count, select-all is selecting work the operator cannot see,
--     and then deleting it.
--     EXPECT: difference = 0 AND ids_not_in_list = 0
WITH list AS (
  SELECT op.piece_id
    FROM order_pieces op
    JOIN orders o          ON o.order_id = op.order_id AND o.company_id = op.company_id
    LEFT JOIN customers cu ON cu.customer_id = o.customer_id
   WHERE op.company_id = (SELECT company_id FROM order_pieces GROUP BY company_id
                           ORDER BY COUNT(*) DESC LIMIT 1)
     AND op.bed_id IS NULL
     AND o.status IN ('confirmed','in_progress','completed','ready_for_shipping','out_for_shipping')
),
ids AS (
  SELECT op.piece_id
    FROM order_pieces op
    JOIN orders o          ON o.order_id = op.order_id AND o.company_id = op.company_id
    LEFT JOIN customers cu ON cu.customer_id = o.customer_id
   WHERE op.company_id = (SELECT company_id FROM order_pieces GROUP BY company_id
                           ORDER BY COUNT(*) DESC LIMIT 1)
     AND op.bed_id IS NULL
     AND o.status IN ('confirmed','in_progress','completed','ready_for_shipping','out_for_shipping')
)
SELECT (SELECT COUNT(*) FROM list) AS list_count,
       (SELECT COUNT(*) FROM ids)  AS ids_count,
       (SELECT COUNT(*) FROM ids) - (SELECT COUNT(*) FROM list) AS difference,
       (SELECT COUNT(*) FROM (SELECT piece_id FROM ids EXCEPT SELECT piece_id FROM list) x)
         AS ids_not_in_list;

-- B7. BULK-ASSIGN candidates (GET /jobs/queue/assignable).
--     EXPECT: runs; cost_inputs comes back as raw jsonb. The assumed time and
--     quantity are NOT computed here on purpose — the client derives them with
--     the same function it always has, because those figures become what a job
--     is priced from.
SELECT op.piece_id, op.piece_name, o.order_number AS order_reference,
       o.deadline::text AS order_deadline, op.required_print_technology,
       op.resin_tank_id, op.cost_inputs,
       CASE WHEN fr.filament_ref_id IS NOT NULL
            THEN fr.brand || ' ' || fr.material_type || ' (' || fr.color || ')'
            ELSE NULL END AS required_filament_label,
       COALESCE(NULLIF(cu.business_name,''),
                NULLIF(TRIM(CONCAT_WS(' ', cu.first_name, cu.last_name)),'')) AS customer_name
  FROM order_pieces op
  JOIN orders o                   ON o.order_id = op.order_id AND o.company_id = op.company_id
  LEFT JOIN customers cu          ON cu.customer_id = o.customer_id
  LEFT JOIN filament_reference fr ON fr.filament_ref_id = op.required_filament_ref_id
 WHERE op.company_id = (SELECT company_id FROM order_pieces GROUP BY company_id
                         ORDER BY COUNT(*) DESC LIMIT 1)
   AND op.bed_id IS NULL
   AND op.status = 'pending'
   AND op.assigned_printer_id IS NULL
   AND o.status IN ('confirmed','in_progress','completed','ready_for_shipping','out_for_shipping')
 ORDER BY op.created_at DESC, op.piece_id ASC
 LIMIT 20;


-- ════════════════════════════════════════════════════════════════
-- C. THE SORT — highest-risk change, and the results I most need
-- ════════════════════════════════════════════════════════════════

-- C1. Does the collation expression behave as measured?
--     The client compares lowercased strings, then breaks ties with
--     localeCompare, which puts lowercase BEFORE uppercase.
--     EXPECT exactly: bracket, Bracket, BRACKET
SELECT name
  FROM (VALUES ('BRACKET'), ('bracket'), ('Bracket')) v(name)
 ORDER BY lower(name) COLLATE "C" ASC, name COLLATE "C" DESC;

-- C2. Is COLLATE "C" available and byte-ordered?
--     EXPECT: 1,B,_,a — digits, then uppercase, then underscore, then lowercase.
SELECT string_agg(ch, ',' ORDER BY ch COLLATE "C") AS byte_order
  FROM (VALUES ('a'), ('B'), ('_'), ('1')) v(ch);

-- C3. THE REAL SORT, top 30. Compare against the Jobs queue TODAY with
--     "Piece name" selected, ascending. Same rows, same order.
SELECT op.piece_name, o.order_number, op.status, op.created_at
  FROM order_pieces op
  JOIN orders o ON o.order_id = op.order_id AND o.company_id = op.company_id
 WHERE op.company_id = (SELECT company_id FROM order_pieces GROUP BY company_id
                         ORDER BY COUNT(*) DESC LIMIT 1)
   AND op.bed_id IS NULL
   AND o.status IN ('confirmed','in_progress','completed','ready_for_shipping','out_for_shipping')
 ORDER BY lower(op.piece_name) COLLATE "C" ASC,
          op.piece_name COLLATE "C" DESC,
          op.created_at DESC, op.piece_id ASC
 LIMIT 30;

-- C4. THE URGENCY SORT, top 30 — the most intricate expression shipped.
--     Compare against the queue TODAY with "Urgency" selected.
--     slack_minutes makes the buckets checkable by eye: negatives first, then
--     <=1440, then <=4320, then the rest.
SELECT op.piece_name, op.status, o.deadline,
       ROUND(((EXTRACT(EPOCH FROM (o.deadline::timestamp AT TIME ZONE 'UTC')) * 1000
               - EXTRACT(EPOCH FROM now()) * 1000) / 60000.0)::numeric, 0) AS slack_minutes,
       (CASE
          WHEN o.deadline IS NULL THEN NULL
          ELSE
            (CASE
               WHEN (EXTRACT(EPOCH FROM (o.deadline::timestamp AT TIME ZONE 'UTC')) * 1000
                     - EXTRACT(EPOCH FROM now()) * 1000) / 60000.0 < 0     THEN 0
               WHEN (EXTRACT(EPOCH FROM (o.deadline::timestamp AT TIME ZONE 'UTC')) * 1000
                     - EXTRACT(EPOCH FROM now()) * 1000) / 60000.0 <= 1440 THEN 1
               WHEN (EXTRACT(EPOCH FROM (o.deadline::timestamp AT TIME ZONE 'UTC')) * 1000
                     - EXTRACT(EPOCH FROM now()) * 1000) / 60000.0 <= 4320 THEN 2
               ELSE 3
             END) * 10000000000000::float8
            + EXTRACT(EPOCH FROM (o.deadline::timestamp AT TIME ZONE 'UTC')) * 1000 * 10
            + CASE op.status
                WHEN 'printing' THEN 0 WHEN 'scheduled' THEN 1 WHEN 'ready'  THEN 2
                WHEN 'assigned' THEN 3 WHEN 'pending'   THEN 4 WHEN 'failed' THEN 5
                WHEN 'done'     THEN 6 WHEN 'cancelled' THEN 7 ELSE 8
              END
        END) AS urgency_key
  FROM order_pieces op
  JOIN orders o ON o.order_id = op.order_id AND o.company_id = op.company_id
 WHERE op.company_id = (SELECT company_id FROM order_pieces GROUP BY company_id
                         ORDER BY COUNT(*) DESC LIMIT 1)
   AND op.bed_id IS NULL
   AND o.status IN ('confirmed','in_progress','completed','ready_for_shipping','out_for_shipping')
 ORDER BY urgency_key ASC,
          lower(op.piece_name) COLLATE "C" ASC, op.piece_name COLLATE "C" DESC,
          op.created_at DESC, op.piece_id ASC
 LIMIT 30;

-- C5. Does the urgency key stay inside float8's exact-integer range?
--     It is bucket*1e13 + epoch_ms*10 + weight. Doubles are exact only to 2^53
--     (~9.007e15). Past that, ordering silently destabilises.
--     EXPECT: max_key ≈ 4.7e13, safe = true
SELECT MAX(k) AS max_key,
       MAX(k) < 9007199254740992 AS safe
  FROM (
    SELECT (CASE
              WHEN (EXTRACT(EPOCH FROM (o.deadline::timestamp AT TIME ZONE 'UTC')) * 1000
                    - EXTRACT(EPOCH FROM now()) * 1000) / 60000.0 < 0 THEN 0 ELSE 3 END)
           * 10000000000000::float8
           + EXTRACT(EPOCH FROM (o.deadline::timestamp AT TIME ZONE 'UTC')) * 1000 * 10 AS k
      FROM order_pieces op
      JOIN orders o ON o.order_id = op.order_id
     WHERE op.company_id = (SELECT company_id FROM order_pieces GROUP BY company_id
                             ORDER BY COUNT(*) DESC LIMIT 1)
       AND o.deadline IS NOT NULL
  ) x;


-- ════════════════════════════════════════════════════════════════
-- D. PERFORMANCE — the index migration is already applied
--
-- NOTE ON ACCURACY: these use the same biggest-tenant subquery, which the
-- planner evaluates as an InitPlan rather than a constant, so its row estimates
-- are less precise than with a literal. The PLAN SHAPE — Index Scan vs Seq Scan,
-- which is what these are for — is still representative. For exact estimates,
-- replace the subquery with a literal '<uuid>'::uuid taken from D4.
-- ════════════════════════════════════════════════════════════════

-- D1. Does the queue's default ordering use an index, or sort the whole table?
--     EXPECT now that the migration is applied: an Index Scan using
--     idx_order_pieces_company_created (or an equivalent), NOT a large Sort.
EXPLAIN (ANALYZE, BUFFERS)
SELECT op.piece_id
  FROM order_pieces op
  JOIN orders o ON o.order_id = op.order_id AND o.company_id = op.company_id
 WHERE op.company_id = (SELECT company_id FROM order_pieces GROUP BY company_id
                         ORDER BY COUNT(*) DESC LIMIT 1)
   AND op.bed_id IS NULL
   AND o.status IN ('confirmed','in_progress','completed','ready_for_shipping','out_for_shipping')
 ORDER BY op.created_at DESC
 LIMIT 200;

-- D2. The colour-slot subquery — correlated, once per projected row.
--     THE ONE I MOST WANT TO SEE. Expect an Index Scan on
--     order_piece_color_slots per loop. A Seq Scan here, multiplied by the row
--     count, is the dominant cost of the whole queue query.
EXPLAIN (ANALYZE, BUFFERS)
SELECT op.piece_id,
       (SELECT COALESCE(json_agg(json_build_object(
                 'color_slot_id',  cs.color_slot_id,
                 'sequence_order', cs.sequence_order,
                 'slot_material',  cs.slot_material,
                 'slot_color',     cs.slot_color,
                 'slicer_grams',   cs.slicer_grams) ORDER BY cs.sequence_order), '[]'::json)
          FROM order_piece_color_slots cs
         WHERE cs.piece_id = op.piece_id) AS color_slots
  FROM order_pieces op
 WHERE op.company_id = (SELECT company_id FROM order_pieces GROUP BY company_id
                         ORDER BY COUNT(*) DESC LIMIT 1)
 LIMIT 500;

-- D3. How expensive is the fingerprint? It runs once a minute per open tab.
--     EXPECT: single-digit to low-tens of milliseconds at 10k pieces.
EXPLAIN (ANALYZE, BUFFERS)
SELECT COUNT(*)::int,
       COALESCE(md5(string_agg(sig, ',' ORDER BY sig)), '-')
  FROM (
    SELECT CONCAT_WS('|', op.piece_id::text, op.status,
             COALESCE(op.fulfilment_status,''), COALESCE(op.post_process_state,''),
             COALESCE(op.piece_name,'')) AS sig
      FROM order_pieces op
     WHERE op.company_id = (SELECT company_id FROM order_pieces GROUP BY company_id
                             ORDER BY COUNT(*) DESC LIMIT 1)
  ) s;

-- D4. Rows per tenant — also tells you which uuid to paste above if you want
--     exact plans, and which tenants are near the 10k target.
--     `stl_without_thumbnail` is how many pieces would have triggered a
--     browser-side STL download + render on the old code path: the size of the
--     problem the visibility gate removed.
SELECT op.company_id,
       COUNT(*)                                            AS pieces,
       COUNT(*) FILTER (WHERE op.bed_id IS NULL)           AS unbedded,
       COUNT(*) FILTER (WHERE op.stl_file_url IS NOT NULL) AS with_stl,
       COUNT(*) FILTER (WHERE op.stl_file_url IS NOT NULL
                          AND op.stl_thumbnail_url IS NULL) AS stl_without_thumbnail
  FROM order_pieces op
 GROUP BY op.company_id
 ORDER BY pieces DESC
 LIMIT 10;
