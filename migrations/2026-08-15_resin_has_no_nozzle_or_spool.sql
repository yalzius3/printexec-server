-- ================================================================
-- RESIN CARRIES NO NOZZLE AND NO SPOOL — clean the stale rows, then keep them out.
--
-- A resin machine cures liquid from a vat. It has no hotend, no extruder and no
-- filament path, so `assigned_nozzle_asset_id` and any `order_piece_spools` row
-- on a resin piece are meaningless by construction.
--
-- They existed anyway, and not as a display bug — as REAL ROWS:
--
--   * Assign wrote `assigned_nozzle_asset_id = COALESCE($4, assigned_nozzle_asset_id)`.
--     A resin assign passes NULL, and COALESCE reads NULL as "leave it alone",
--     so a piece that was FDM and was later switched to MSLA/SLA kept its old
--     nozzle id forever. Nothing downstream could distinguish that stale id from
--     a live one.
--   * Spool reservations were never released on the same switch, so grams stayed
--     held against stock that would never be consumed.
--
-- The visible symptom was a resin printer's schedule board drawing a
-- "Nozzle · 0.40mm brass" lane: the board was faithfully rendering a real column.
-- The service layer now clears the other technology's tooling on every assign
-- (see SimpleJobsService.assign), which stops NEW rows. This migration removes
-- the ones already written — without it, existing resin work keeps its ghost
-- nozzle and ghost reservation forever.
--
-- Idempotent: re-running matches nothing the second time. Safe to apply before
-- or after the API that stops producing these.
-- ================================================================

BEGIN;

-- 1. Release spool reservations held by resin pieces. Deleting the join row is
--    what frees the grams: asset_stock.reserved_grams is recomputed from
--    order_piece_spools, so the stock figures correct themselves.
DELETE FROM public.order_piece_spools ops
 USING public.order_pieces op
 WHERE op.piece_id = ops.piece_id
   AND op.required_print_technology IN ('MSLA', 'SLA');

-- 2. Drop the ghost nozzle from resin pieces.
UPDATE public.order_pieces
   SET assigned_nozzle_asset_id = NULL
 WHERE required_print_technology IN ('MSLA', 'SLA')
   AND assigned_nozzle_asset_id IS NOT NULL;

-- 3. Same for packed resin PLATES. print_beds duplicates the piece's tooling
--    columns, so it grew the identical ghost.
UPDATE public.print_beds
   SET assigned_nozzle_asset_id = NULL
 WHERE required_print_technology IN ('MSLA', 'SLA')
   AND assigned_nozzle_asset_id IS NOT NULL;

-- 4. A resin PRINTER can never be nozzle-compatible with anything. The create
--    path enforced this; POST /printers/:id/nozzles did not, so nozzles could be
--    attached after the fact (now refused in PrintersService.addNozzleCompatibility).
--    Remove any that were.
DELETE FROM public.printer_nozzle_compatibility pnc
 USING public.printer_instances pi
 WHERE pi.printer_id = pnc.printer_id
   AND pi.print_technology IN ('MSLA', 'SLA');

COMMIT;
