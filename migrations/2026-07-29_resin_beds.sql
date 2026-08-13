-- ================================================================
-- RESIN BEDS: give a packed resin PLATE the same two facts a resin piece has.
--
-- 2026-07-27_resin_tech.sql made a resin PIECE a first-class citizen: it draws
-- millilitres from a tank, has no nozzle, and is gated on those two facts by
-- chk_ready_requires_core_data. Beds were left entirely FDM-shaped, and because
-- a bed's readiness/assign/schedule path asks for a NOZZLE and for FILAMENT
-- GRAMS, a resin bed was a dead end in the strictest sense: creatable (the
-- combine modal offers MSLA/SLA), then permanently unassignable, unschedulable
-- and unprintable, with no error that named the real cause.
--
-- An MSLA plate holding twelve parts is the normal way to run resin — the whole
-- point of the technology — so this is the missing half of the resin layer, not
-- an edge case.
--
-- Two columns, mirroring order_pieces exactly:
--
--   resin_tank_id         -- FK to the tank this plate pours from
--   slicer_resin_used_ml  -- what the whole plate draws, in millilitres
--
-- Why store them on the bed rather than derive them from the constituent
-- pieces: print_beds ALREADY duplicates required_filament_material,
-- required_nozzle_*, slicer_print_time_minutes and slicer_filament_used_grams
-- from its pieces, because a packed plate's real numbers are a property of the
-- PLATE (one sliced file, one pour), not the sum of the parts on it. Resin
-- follows the same rule or it would be the one material whose plate figures
-- are guessed.
--
-- Deliberately NOT added: post_process_state. That stays derived from the
-- pieces (see the LATERAL in BedsService.bedSelectSql) exactly as
-- fulfilment_status is — 2026-07-27's note explains why, and nothing here
-- changes it.
--
-- Idempotent: safe to re-run. Additive and nullable, so it is also safe to
-- apply BEFORE the API that uses it is deployed.
-- ================================================================

BEGIN;

ALTER TABLE public.print_beds
  ADD COLUMN IF NOT EXISTS resin_tank_id UUID,
  ADD COLUMN IF NOT EXISTS slicer_resin_used_ml NUMERIC;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.print_beds'::regclass
       AND conname = 'print_beds_resin_tank_id_fkey'
  ) THEN
    -- ON DELETE SET NULL for the same reason order_pieces uses it: deleting a
    -- spent tank must never be blocked by the history of plates it poured. The
    -- bed keeps its recorded slicer_resin_used_ml, so the consumption record
    -- outlives the tank.
    ALTER TABLE public.print_beds
      ADD CONSTRAINT print_beds_resin_tank_id_fkey
      FOREIGN KEY (resin_tank_id)
      REFERENCES public.asset_instances (asset_id)
      ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_print_beds_resin_tank
  ON public.print_beds (resin_tank_id)
  WHERE resin_tank_id IS NOT NULL;

-- ---------------------------------------------------------------
-- Tank reservations must count plates too
-- ---------------------------------------------------------------
-- fn_recalc_reserved_volume_for_tank (2026-07-27) sums only order_pieces. A
-- bed-owned piece has its own scheduling fields nulled — the BED carries the
-- window and the volume — so a committed resin plate reserved nothing, and the
-- tank read as having free volume it had already promised away.
--
-- Both arms exclude the other's rows: `op.bed_id IS NULL` keeps a plate's
-- constituent pieces from being counted a second time alongside the plate.
CREATE OR REPLACE FUNCTION public.fn_recalc_reserved_volume_for_tank(p_tank_id UUID)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.asset_stock ast
     SET reserved_volume_ml =
           COALESCE((
             SELECT SUM(op.slicer_resin_used_ml)
               FROM public.order_pieces op
              WHERE op.resin_tank_id = p_tank_id
                AND op.bed_id IS NULL
                AND op.status IN ('scheduled', 'printing')
           ), 0)
         + COALESCE((
             SELECT SUM(pb.slicer_resin_used_ml)
               FROM public.print_beds pb
              WHERE pb.resin_tank_id = p_tank_id
                AND pb.status IN ('scheduled', 'printing')
           ), 0)
   WHERE ast.asset_id = p_tank_id;
$$;

-- The bed-side trigger, mirroring trg_order_pieces_resin_reservation_*.
CREATE OR REPLACE FUNCTION public.fn_print_beds_resin_reservation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Recompute BOTH sides so moving a plate from tank A to tank B releases A.
  IF TG_OP <> 'INSERT' AND OLD.resin_tank_id IS NOT NULL THEN
    PERFORM public.fn_recalc_reserved_volume_for_tank(OLD.resin_tank_id);
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.resin_tank_id IS NOT NULL THEN
    PERFORM public.fn_recalc_reserved_volume_for_tank(NEW.resin_tank_id);
  END IF;
  RETURN NULL; -- AFTER trigger; the return value is ignored
END
$$;

DROP TRIGGER IF EXISTS trg_print_beds_resin_reservation_ins ON public.print_beds;
CREATE TRIGGER trg_print_beds_resin_reservation_ins
  AFTER INSERT ON public.print_beds
  FOR EACH ROW
  WHEN (NEW.resin_tank_id IS NOT NULL)
  EXECUTE FUNCTION public.fn_print_beds_resin_reservation();

DROP TRIGGER IF EXISTS trg_print_beds_resin_reservation_upd ON public.print_beds;
CREATE TRIGGER trg_print_beds_resin_reservation_upd
  AFTER UPDATE ON public.print_beds
  FOR EACH ROW
  -- Gated to the three columns that can move a reservation, so the trigger
  -- stays off every unrelated bed edit (renames, file swaps, nozzle changes).
  WHEN (
    OLD.resin_tank_id IS DISTINCT FROM NEW.resin_tank_id
    OR OLD.status IS DISTINCT FROM NEW.status
    OR OLD.slicer_resin_used_ml IS DISTINCT FROM NEW.slicer_resin_used_ml
  )
  EXECUTE FUNCTION public.fn_print_beds_resin_reservation();

DROP TRIGGER IF EXISTS trg_print_beds_resin_reservation_del ON public.print_beds;
CREATE TRIGGER trg_print_beds_resin_reservation_del
  AFTER DELETE ON public.print_beds
  FOR EACH ROW
  WHEN (OLD.resin_tank_id IS NOT NULL)
  EXECUTE FUNCTION public.fn_print_beds_resin_reservation();

-- Converge every tank onto the rule above (they are all piece-only today, but a
-- re-run after real plate data exists must still settle correctly).
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
