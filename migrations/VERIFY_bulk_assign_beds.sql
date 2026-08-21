-- ================================================================
-- VERIFY: beds in bulk assign + the auto-schedule window report
--
-- Read-only. Writes nothing, reads no customer data beyond counts.
-- Run it whole; the final SELECT is the answer.
--
--   A_pass  print_beds carries every column the new statements name
--   B_pass  the bed-assign write parses and plans against THIS schema
--   C_pass  the assignable-beds read parses and plans against THIS schema
--   D_pass  bed readiness is enforced in the application layer, not by a
--           CHECK this write would have to restate exactly
--   E       how many plates the new Bulk Assign will actually show today
--
-- WHY B AND C ARE PREPARE, NOT SELECT
-- PREPARE parses and analyses a statement against the live schema WITHOUT
-- executing it, so every column, cast, aggregate and GROUP BY is checked and
-- no row is read or written. A wrong column aborts the run with the real
-- message — which is the point. Reaching the final SELECT means both are valid
-- here. It proves the statements RUN; it does not prove the answers are right,
-- which is what the PGlite differential covers instead.
--
-- WHY D MATTERS MORE THAN IT LOOKS
-- order_pieces has chk_ready_requires_core_data, and any write that sets
-- status='ready' must state that rule EXACTLY or Postgres raises a check
-- violation that surfaces as a bare 500 (this is what caused "500 on every
-- resin assign"). 2026-06-30_metadata_driven_readiness.sql left the print_beds
-- equivalent COMMENTED OUT on purpose — bed readiness is application-enforced.
-- If D_pass is FALSE, a constraint has since been added and the status CASE in
-- SimpleJobsService.assign()'s bed arm must be re-checked against it before
-- this ships.
-- ================================================================

-- ── B. The bed-assign write, parsed against this schema. Never executed. ────
PREPARE px_bed_assign (uuid, uuid[], uuid, uuid[], int[], numeric[], uuid[], numeric[], boolean[]) AS
UPDATE print_beds pb
   SET assigned_printer_id = $3,
       assigned_nozzle_asset_id = CASE
         WHEN s.is_resin THEN NULL
         ELSE COALESCE(s.nozzle, pb.assigned_nozzle_asset_id)
       END,
       resin_tank_id = CASE
         WHEN s.is_resin THEN COALESCE(s.tank, pb.resin_tank_id)
         ELSE NULL
       END,
       slicer_print_time_minutes  = COALESCE(s.minutes, pb.slicer_print_time_minutes),
       slicer_filament_used_grams = CASE
         WHEN s.is_resin THEN NULL
         ELSE COALESCE(s.grams, pb.slicer_filament_used_grams)
       END,
       slicer_resin_used_ml       = CASE
         WHEN s.is_resin THEN COALESCE(s.ml, pb.slicer_resin_used_ml)
         ELSE NULL
       END,
       status = CASE
         WHEN s.is_resin THEN
           CASE WHEN COALESCE(s.minutes, pb.slicer_print_time_minutes) IS NOT NULL
                 AND COALESCE(s.ml, pb.slicer_resin_used_ml) IS NOT NULL
                 AND COALESCE(s.tank, pb.resin_tank_id) IS NOT NULL
                THEN 'ready' ELSE 'assigned' END
         WHEN COALESCE(s.nozzle, pb.assigned_nozzle_asset_id) IS NOT NULL
          AND COALESCE(s.minutes, pb.slicer_print_time_minutes) IS NOT NULL
          AND COALESCE(s.grams, pb.slicer_filament_used_grams) IS NOT NULL THEN 'ready'
         WHEN COALESCE(s.nozzle, pb.assigned_nozzle_asset_id) IS NOT NULL THEN 'assigned'
         ELSE pb.status
       END
  FROM unnest($2::uuid[], $4::uuid[], $5::int[], $6::numeric[], $7::uuid[], $8::numeric[], $9::boolean[])
    AS s(bed_id, nozzle, minutes, grams, tank, ml, is_resin)
 WHERE pb.company_id = $1
   AND pb.bed_id = s.bed_id;

DEALLOCATE px_bed_assign;

-- ── C. The assignable-plates read, parsed against this schema. ──────────────
PREPARE px_assignable_beds (uuid, text) AS
SELECT
           b.bed_id            AS piece_id,
           b.bed_name          AS piece_name,
           b.effective_deadline::text AS order_deadline,
           b.required_print_technology,
           b.resin_tank_id,
           -- Byte-identical to BedsService.bedSelectSql's expression (note the
           -- ' · ' separator, which differs from the piece one above), so a
           -- plate reads the same here as in the row the operator clicked from.
           CASE WHEN fr.filament_ref_id IS NOT NULL
                THEN fr.brand || ' ' || fr.material_type || ' · ' || fr.color
                ELSE NULL END AS required_filament_label,
           -- A plate can hold pieces from several orders, so there is no single
           -- order number to show. Name the one when there IS one, and say how
           -- many otherwise — a count is honest where a first-row guess is not.
           CASE WHEN COUNT(DISTINCT o.order_id) = 1
                THEN MIN(o.order_number)
                ELSE COUNT(DISTINCT o.order_id)::text || ' orders'
           END AS order_reference,
           CASE WHEN COUNT(DISTINCT o.customer_id) = 1
                THEN MIN(COALESCE(
                       NULLIF(cu.business_name, ''),
                       NULLIF(TRIM(CONCAT_WS(' ', cu.first_name, cu.last_name)), '')
                     ))
                ELSE NULL
           END AS customer_name
           -- Deliberately NOT shipping the constituent quotes.
           --
           -- A plate's assumed time and quantity are seeded SERVER-side at
           -- assign time, from these same rows; the list only has to let the
           -- operator choose. Sending them so the client could re-sum them was
           -- a body computed and then discarded — nothing rendered it, and
           -- piece rows show no assumed figures either — at roughly a dozen
           -- quote objects per plate. Showing them would also have been a
           -- half-truth, because the seed only applies when the plate has no
           -- figures of its own.
         FROM print_beds b
         LEFT JOIN order_pieces op ON op.bed_id = b.bed_id AND op.company_id = b.company_id
         LEFT JOIN orders o        ON o.order_id = op.order_id AND o.company_id = op.company_id
         LEFT JOIN customers cu    ON cu.customer_id = o.customer_id
         LEFT JOIN filament_reference fr ON fr.filament_ref_id = b.required_filament_ref_id
        WHERE b.company_id = $1
          AND b.status = 'pending'
          AND b.assigned_printer_id IS NULL
          -- Search matches the plate's own name OR anything identifying the work
          -- packed on it. Name-only looked sufficient and was a trap: searching a
          -- customer returned their loose pieces but hid the plate holding their
          -- parts, so the operator would assign the pieces and leave the plate
          -- behind — the exact omission this whole change exists to stop.
          AND (
            LOWER(b.bed_name) LIKE $2
            OR EXISTS (
              SELECT 1
                FROM order_pieces sp
                JOIN orders so      ON so.order_id = sp.order_id AND so.company_id = sp.company_id
                LEFT JOIN customers scu ON scu.customer_id = so.customer_id
               WHERE sp.company_id = b.company_id
                 AND sp.bed_id = b.bed_id
                 AND (
                   LOWER(sp.piece_name) LIKE $2
                   OR LOWER(so.order_number) LIKE $2
                   OR LOWER(COALESCE(
                        NULLIF(scu.business_name, ''),
                        NULLIF(TRIM(CONCAT_WS(' ', scu.first_name, scu.last_name)), '')
                      )) LIKE $2
                 )
            )
          )
          -- Order scoping, matching the piece arm above.
          --
          -- Without this a plate whose work was cancelled or is still a draft
          -- would sit in the same list as live pieces and could be given a
          -- printer — and because assigning also SEEDS its print data, it would
          -- reach 'ready' and go on to occupy a real slot in the fleet pack.
          -- Machine time booked for work nobody ordered.
          --
          -- Spelled as EXISTS over the constituent pieces rather than a join
          -- predicate because a plate can hold pieces from several orders:
          -- the plate is live if ANY part of it is, which is the same rule
          -- jobSelectSql's bed arm applies. The status list is the PIECE arm's,
          -- deliberately — a plate and a loose piece from one order must appear
          -- or vanish together, and they sit side by side in this one modal.
          AND EXISTS (
            SELECT 1
              FROM order_pieces cp
              JOIN orders co ON co.order_id = cp.order_id AND co.company_id = cp.company_id
             WHERE cp.company_id = b.company_id
               AND cp.bed_id = b.bed_id
               AND co.status IN ('confirmed','in_progress','completed','ready_for_shipping','out_for_shipping')
          )
        GROUP BY b.bed_id, b.bed_name, b.effective_deadline,
                 b.required_print_technology, b.resin_tank_id,
                 fr.filament_ref_id, fr.brand, fr.material_type, fr.color,
                 b.created_at
        ORDER BY b.created_at DESC, b.bed_id ASC;

DEALLOCATE px_assignable_beds;

-- ── The answer. One row, because a hosted SQL editor shows only the last. ───
WITH cols AS (
  SELECT COUNT(*) AS n
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'print_beds'
     AND column_name IN (
       'bed_id','company_id','bed_name','status','required_print_technology',
       'required_filament_ref_id','required_filament_material',
       'required_nozzle_diameter_mm','required_nozzle_material',
       'slicer_print_time_minutes','slicer_filament_used_grams',
       'slicer_resin_used_ml','resin_tank_id','assigned_printer_id',
       'assigned_nozzle_asset_id','effective_deadline','created_at')
),
bed_checks AS (
  SELECT COUNT(*) AS n
    FROM pg_constraint
   WHERE contype = 'c'
     AND conrelid = 'public.print_beds'::regclass
     AND conname IN ('chk_ready_requires_core_data', 'chk_scheduled_requires_core_data')
),
plates AS (
  SELECT
    -- Must apply the SAME scoping the read above does, or this number promises
    -- plates the list then doesn't show and the feature reads as broken. The
    -- EXISTS is the order-status rule; it is also what excludes a plate with no
    -- constituent pieces left on it.
    COUNT(*) FILTER (
      WHERE pb.status = 'pending'
        AND pb.assigned_printer_id IS NULL
        AND EXISTS (
          SELECT 1
            FROM order_pieces cp
            JOIN orders co ON co.order_id = cp.order_id AND co.company_id = cp.company_id
           WHERE cp.company_id = pb.company_id
             AND cp.bed_id = pb.bed_id
             AND co.status IN ('confirmed','in_progress','completed','ready_for_shipping','out_for_shipping')
        )
    ) AS assignable_now,
    -- listSchedulable's bed arm, which deliberately does NOT scope by order
    -- status — neither does its piece arm. Once something is 'ready' with a
    -- printer it is schedulable. Mirrored here rather than "corrected", so the
    -- number matches the packer.
    COUNT(*) FILTER (WHERE pb.status = 'ready' AND pb.assigned_printer_id IS NOT NULL
                       AND pb.scheduled_start_at IS NULL)                       AS schedulable_now,
    COUNT(*)                                                                    AS total
  FROM print_beds pb
)
SELECT jsonb_pretty(jsonb_build_object(
  'A_pass', (SELECT n FROM cols) = 17,
  'A_columns_found', (SELECT n FROM cols),
  'B_pass', true,   -- reaching this row means the PREPARE above succeeded
  'C_pass', true,   -- ditto
  'D_pass', (SELECT n FROM bed_checks) = 0,
  'D_note', CASE WHEN (SELECT n FROM bed_checks) = 0
                 THEN 'bed readiness is application-enforced, as the 2026-06-30 migration intended'
                 ELSE 'a readiness CHECK now exists on print_beds — re-check the status CASE in assign() before shipping'
            END,
  'E_beds_bulk_assign_will_show', (SELECT assignable_now FROM plates),
  'E_beds_auto_schedule_will_pack', (SELECT schedulable_now FROM plates),
  'E_beds_total', (SELECT total FROM plates),
  'checked_at', now()
)) AS result;
