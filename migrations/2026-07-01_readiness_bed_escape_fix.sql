-- ================================================================
-- Corrective follow-up to 2026-06-30_metadata_driven_readiness.sql.
--
-- That migration re-created chk_ready_requires_core_data and
-- chk_scheduled_requires_core_data gated on slicer METADATA, but DROPPED the
-- `OR (bed_id IS NOT NULL)` escape hatch that every sibling status constraint
-- (chk_assigned_requires_printer, chk_printing_requires_started_at, …) carries.
--
-- That escape is essential: a piece that lives inside a bed has its lifecycle
-- owned by the bed — its own assigned_printer/nozzle/slicer fields are nulled
-- and it mirrors the bed's status. Without the escape, scheduling a bed (which
-- propagates status='scheduled' onto its child pieces, whose slicer fields are
-- null) would be REJECTED. The constraints were NOT VALID, so existing rows
-- were safe, but NOT VALID still enforces new writes — hence this fix before a
-- bed is next scheduled.
--
-- This migration:
--   1. Reconciles the one standalone 'ready' piece that has a file but no
--      slicer time/grams (it can't be scheduled anyway) down to 'assigned'.
--   2. Re-adds both constraints WITH the bed_id escape, gated on metadata, and
--      VALIDATED (no remaining violators after step 1).
--
-- Idempotent. Wrapped in a transaction — all-or-nothing.
-- ================================================================

BEGIN;

-- 1) Standalone (not bed-owned) pieces that are 'ready' but lack slicer time or
--    grams no longer qualify as ready under the metadata rule. Drop them to
--    'assigned' — they keep printer + nozzle + any file; re-confirming the
--    slicer metadata promotes them back to 'ready'. Bed-owned pieces are left
--    alone (the bed owns their lifecycle).
UPDATE public.order_pieces
   SET status = 'assigned'
 WHERE status = 'ready'
   AND bed_id IS NULL
   AND (slicer_print_time_minutes IS NULL OR slicer_filament_used_grams IS NULL);

-- 2) Re-add the readiness constraints WITH the bed_id escape, gated on slicer
--    METADATA (print time + filament grams).
ALTER TABLE public.order_pieces DROP CONSTRAINT IF EXISTS chk_ready_requires_core_data;
ALTER TABLE public.order_pieces
  ADD CONSTRAINT chk_ready_requires_core_data
  CHECK (
    status <> 'ready'
    OR bed_id IS NOT NULL
    OR (assigned_printer_id IS NOT NULL
        AND assigned_nozzle_asset_id IS NOT NULL
        AND slicer_print_time_minutes IS NOT NULL
        AND slicer_filament_used_grams IS NOT NULL)
  );

ALTER TABLE public.order_pieces DROP CONSTRAINT IF EXISTS chk_scheduled_requires_core_data;
ALTER TABLE public.order_pieces
  ADD CONSTRAINT chk_scheduled_requires_core_data
  CHECK (
    status <> ALL (ARRAY['scheduled'::text, 'printing'::text])
    OR bed_id IS NOT NULL
    OR (assigned_printer_id IS NOT NULL
        AND assigned_nozzle_asset_id IS NOT NULL
        AND slicer_print_time_minutes IS NOT NULL
        AND slicer_filament_used_grams IS NOT NULL)
  );

COMMIT;
