-- ================================================================
-- RESIN TECH: resin tanks as real inventory + the post-processing state machine.
--
-- Resin (MSLA/SLA) has been half-present for a long time: printer_reference
-- already accepts MSLA/SLA, order_pieces.required_print_technology already
-- allows them, and asset_instances already carries a handful of resin_* columns
-- behind a locked "Resins" tab. What was missing is everything that makes a
-- material tradeable the way filament is — cost, shelf life, a volume that goes
-- DOWN when a job prints — and the fact that a resin print is not finished when
-- the printer stops: it still has to be washed and cured.
--
-- Three additive groups, all nullable, all idempotent.
--
--  1. asset_instances — resin tank identity/inventory
--       resin_tech_compat      -- MSLA | SLA | both (a tank is not always both)
--       resin_total_volume_ml  -- bottle size, the restock reference. Distinct
--                                 from resin_initial_volume_ml, which is what
--                                 THIS instance was filled with.
--       resin_opened_at        -- shelf life starts on opening, not purchase
--       resin_expiry_date
--       resin_datasheet_url    -- manufacturer sheet (wash time, cure time, …)
--     Cost per litre is NOT stored: purchase_price (already present, already the
--     per-instance price everywhere else) over resin_initial_volume_ml IS the
--     cost per ml, and a second stored copy would be free to drift.
--
--  2. order_pieces — what a resin job draws and how far post-processing got
--       resin_tank_id                 -- FK to the tank feeding this piece
--       slicer_resin_used_ml          -- the slicer's volume estimate
--       post_process_state            -- print_done | washed | cured
--       post_process_state_entered_at -- stamped on EVERY state change; the
--                                        needs-attention queue sorts on it
--     print_beds deliberately gets NO post-process columns: a bed has no
--     fulfilment column either — it derives its stage from its pieces and walks
--     them in lockstep (see BedsService.transitionBedFulfilment). Same rule here.
--
--  3. fn_recalc_reserved_volume_for_tank — the sole writer of
--     asset_stock.reserved_volume_ml, mirroring the existing
--     fn_recalc_reserved_grams_for_spool convention for filament. Filament
--     reservations live in the order_piece_spools join table, so its trigger
--     sits there; a resin reservation is a column ON the piece, so this trigger
--     sits on order_pieces and is gated (WHEN ...) to the three columns that can
--     actually change a reservation.
--
-- Idempotent: safe to re-run.
-- ================================================================

BEGIN;

-- ---------------------------------------------------------------
-- 1. Resin tank inventory columns
-- ---------------------------------------------------------------
ALTER TABLE public.asset_instances
  ADD COLUMN IF NOT EXISTS resin_tech_compat TEXT,
  ADD COLUMN IF NOT EXISTS resin_total_volume_ml NUMERIC,
  ADD COLUMN IF NOT EXISTS resin_opened_at DATE,
  ADD COLUMN IF NOT EXISTS resin_expiry_date DATE,
  ADD COLUMN IF NOT EXISTS resin_datasheet_url TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.asset_instances'::regclass
       AND conname = 'asset_instances_resin_tech_compat_check'
  ) THEN
    -- NOT VALID: constrains every new write without re-validating legacy rows.
    ALTER TABLE public.asset_instances
      ADD CONSTRAINT asset_instances_resin_tech_compat_check
      CHECK (resin_tech_compat IS NULL OR resin_tech_compat IN ('MSLA', 'SLA', 'both'))
      NOT VALID;
  END IF;
END
$$;

-- Existing tanks predate the compatibility field. "both" is the safe backfill:
-- it keeps every tank pickable for every resin printer, exactly as today.
UPDATE public.asset_instances
   SET resin_tech_compat = 'both'
 WHERE asset_type = 'resin_tank'
   AND resin_tech_compat IS NULL;

-- A tank's bottle size defaults to what it was filled with.
UPDATE public.asset_instances
   SET resin_total_volume_ml = resin_initial_volume_ml
 WHERE asset_type = 'resin_tank'
   AND resin_total_volume_ml IS NULL
   AND resin_initial_volume_ml IS NOT NULL;

-- ---------------------------------------------------------------
-- 2. Piece-level resin linkage + post-processing state
-- ---------------------------------------------------------------
ALTER TABLE public.order_pieces
  ADD COLUMN IF NOT EXISTS resin_tank_id UUID,
  ADD COLUMN IF NOT EXISTS slicer_resin_used_ml NUMERIC,
  ADD COLUMN IF NOT EXISTS post_process_state TEXT,
  ADD COLUMN IF NOT EXISTS post_process_state_entered_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.order_pieces'::regclass
       AND conname = 'order_pieces_resin_tank_id_fkey'
  ) THEN
    -- ON DELETE SET NULL, not RESTRICT: deleting a spent tank must never be
    -- blocked by the history of jobs it fed. The piece keeps its recorded
    -- slicer_resin_used_ml, so the consumption record survives the tank.
    ALTER TABLE public.order_pieces
      ADD CONSTRAINT order_pieces_resin_tank_id_fkey
      FOREIGN KEY (resin_tank_id)
      REFERENCES public.asset_instances (asset_id)
      ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.order_pieces'::regclass
       AND conname = 'order_pieces_post_process_state_check'
  ) THEN
    ALTER TABLE public.order_pieces
      ADD CONSTRAINT order_pieces_post_process_state_check
      CHECK (post_process_state IS NULL OR post_process_state IN ('print_done', 'washed', 'cured'))
      NOT VALID;
  END IF;
END
$$;

-- The needs-attention queue: pieces stuck between the printer and a finished
-- part, oldest first. Partial index — 'cured' pieces have left the queue and
-- FDM pieces never enter it, so neither belongs in the index.
CREATE INDEX IF NOT EXISTS idx_order_pieces_post_process
  ON public.order_pieces (company_id, post_process_state_entered_at)
  WHERE post_process_state IN ('print_done', 'washed');

CREATE INDEX IF NOT EXISTS idx_order_pieces_resin_tank
  ON public.order_pieces (resin_tank_id)
  WHERE resin_tank_id IS NOT NULL;

-- ---------------------------------------------------------------
-- 2b. Readiness constraints, per technology
-- ---------------------------------------------------------------
-- chk_ready_requires_core_data and chk_scheduled_requires_core_data (see
-- 2026-06-30_metadata_driven_readiness.sql and 2026-07-01_readiness_bed_escape_fix.sql)
-- gate 'ready'/'scheduled' on a NOZZLE and FILAMENT GRAMS. Both are FDM-only
-- facts: a resin printer has no nozzle, and resin is measured in millilitres —
-- so as written these constraints reject every resin piece that tries to become
-- schedulable.
--
-- Rewritten to ask the same question in the technology's own terms:
--   resin (MSLA/SLA) -> printer + print time + resin millilitres + a tank
--   everything else  -> printer + nozzle + print time + filament grams
-- The bed_id escape hatch is preserved verbatim — a bed-owned piece has its
-- lifecycle owned by the bed and its own fields nulled.
ALTER TABLE public.order_pieces DROP CONSTRAINT IF EXISTS chk_ready_requires_core_data;
ALTER TABLE public.order_pieces
  ADD CONSTRAINT chk_ready_requires_core_data
  CHECK (
    status <> 'ready'
    OR bed_id IS NOT NULL
    OR (
      CASE WHEN required_print_technology IN ('MSLA', 'SLA') THEN
        assigned_printer_id IS NOT NULL
        AND slicer_print_time_minutes IS NOT NULL
        AND slicer_resin_used_ml IS NOT NULL
        AND resin_tank_id IS NOT NULL
      ELSE
        assigned_printer_id IS NOT NULL
        AND assigned_nozzle_asset_id IS NOT NULL
        AND slicer_print_time_minutes IS NOT NULL
        AND slicer_filament_used_grams IS NOT NULL
      END
    )
  ) NOT VALID;

ALTER TABLE public.order_pieces DROP CONSTRAINT IF EXISTS chk_scheduled_requires_core_data;
ALTER TABLE public.order_pieces
  ADD CONSTRAINT chk_scheduled_requires_core_data
  CHECK (
    status <> ALL (ARRAY['scheduled'::text, 'printing'::text])
    OR bed_id IS NOT NULL
    OR (
      CASE WHEN required_print_technology IN ('MSLA', 'SLA') THEN
        assigned_printer_id IS NOT NULL
        AND slicer_print_time_minutes IS NOT NULL
        AND slicer_resin_used_ml IS NOT NULL
        AND resin_tank_id IS NOT NULL
      ELSE
        assigned_printer_id IS NOT NULL
        AND assigned_nozzle_asset_id IS NOT NULL
        AND slicer_print_time_minutes IS NOT NULL
        AND slicer_filament_used_grams IS NOT NULL
      END
    )
  ) NOT VALID;

-- NOT VALID on both: they constrain every NEW write (all the app needs), while
-- skipping a re-scan of history. Any legacy resin piece that reached 'ready'
-- under the old FDM-shaped rule — with a nozzle and grams but no tank — would
-- otherwise abort this migration, and rewriting historical rows to satisfy a new
-- rule is not something a schema change should do silently.

-- ---------------------------------------------------------------
-- 2c. Material waste, in the material's own unit
-- ---------------------------------------------------------------
-- filament_waste_events (2026-07-12_filament_waste.sql) records a failed print's
-- scrap: an asset, a quantity, a unit cost, a cost. All of that is true of resin
-- too — the only thing that isn't is the assumption that the quantity is grams.
--
-- So rather than a parallel resin_waste_events table (a second schema, a second
-- Finance posting path, a second dashboard query, all to say the same thing), the
-- quantity gains a UNIT. spool_asset_id already references asset_instances, and a
-- resin tank IS an asset_instances row, so it carries the tank with no FK change.
--
-- Existing rows are all filament, hence the 'g' default.
ALTER TABLE public.filament_waste_events
  ADD COLUMN IF NOT EXISTS unit TEXT NOT NULL DEFAULT 'g';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.filament_waste_events'::regclass
       AND conname = 'filament_waste_events_unit_check'
  ) THEN
    ALTER TABLE public.filament_waste_events
      ADD CONSTRAINT filament_waste_events_unit_check
      CHECK (unit IN ('g', 'ml'))
      NOT VALID;
  END IF;
END
$$;

-- Every query that sums the quantity column MUST filter by unit — summing grams
-- and millilitres together would produce a number that means nothing. The index
-- makes that filter free.
CREATE INDEX IF NOT EXISTS idx_filament_waste_events_unit
  ON public.filament_waste_events (company_id, unit, created_at DESC);

-- ---------------------------------------------------------------
-- 3. reserved_volume_ml — recomputed, never incremented
-- ---------------------------------------------------------------
-- A tank's reservation is the sum of the resin its committed jobs still owe it.
-- 'scheduled' and 'printing' are the committed states, matching the spool
-- convention exactly: a piece below 'scheduled' reserves nothing, and a piece
-- at 'done'/'failed' has already had its volume physically deducted from
-- remaining_volume_ml (JobsService.consumeResinTx), so counting it here too
-- would double-charge the tank.
CREATE OR REPLACE FUNCTION public.fn_recalc_reserved_volume_for_tank(p_tank_id UUID)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.asset_stock ast
     SET reserved_volume_ml = COALESCE((
           SELECT SUM(op.slicer_resin_used_ml)
             FROM public.order_pieces op
            WHERE op.resin_tank_id = p_tank_id
              AND op.status IN ('scheduled', 'printing')
         ), 0)
   WHERE ast.asset_id = p_tank_id;
$$;

CREATE OR REPLACE FUNCTION public.fn_order_pieces_resin_reservation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Recompute BOTH sides so moving a job from tank A to tank B releases A.
  IF TG_OP <> 'INSERT' AND OLD.resin_tank_id IS NOT NULL THEN
    PERFORM public.fn_recalc_reserved_volume_for_tank(OLD.resin_tank_id);
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.resin_tank_id IS NOT NULL THEN
    PERFORM public.fn_recalc_reserved_volume_for_tank(NEW.resin_tank_id);
  END IF;
  RETURN NULL; -- AFTER trigger; the return value is ignored
END
$$;

DROP TRIGGER IF EXISTS trg_order_pieces_resin_reservation_ins ON public.order_pieces;
CREATE TRIGGER trg_order_pieces_resin_reservation_ins
  AFTER INSERT ON public.order_pieces
  FOR EACH ROW
  WHEN (NEW.resin_tank_id IS NOT NULL)
  EXECUTE FUNCTION public.fn_order_pieces_resin_reservation();

DROP TRIGGER IF EXISTS trg_order_pieces_resin_reservation_upd ON public.order_pieces;
CREATE TRIGGER trg_order_pieces_resin_reservation_upd
  AFTER UPDATE ON public.order_pieces
  FOR EACH ROW
  -- Gated to the three columns that can move a reservation. Without this the
  -- trigger would fire on every piece edit — including the thumbnail writes and
  -- fulfilment flips that have nothing to do with resin.
  WHEN (
    OLD.resin_tank_id IS DISTINCT FROM NEW.resin_tank_id
    OR OLD.status IS DISTINCT FROM NEW.status
    OR OLD.slicer_resin_used_ml IS DISTINCT FROM NEW.slicer_resin_used_ml
  )
  EXECUTE FUNCTION public.fn_order_pieces_resin_reservation();

DROP TRIGGER IF EXISTS trg_order_pieces_resin_reservation_del ON public.order_pieces;
CREATE TRIGGER trg_order_pieces_resin_reservation_del
  AFTER DELETE ON public.order_pieces
  FOR EACH ROW
  WHEN (OLD.resin_tank_id IS NOT NULL)
  EXECUTE FUNCTION public.fn_order_pieces_resin_reservation();

-- Bring every existing tank's reservation in line with the rule above (they
-- are all 0 today, but a re-run after backfilling data must still converge).
DO $$
DECLARE
  tank RECORD;
BEGIN
  FOR tank IN
    SELECT asset_id FROM public.asset_instances WHERE asset_type = 'resin_tank'
  LOOP
    PERFORM public.fn_recalc_reserved_volume_for_tank(tank.asset_id);
  END LOOP;
END
$$;

COMMIT;
