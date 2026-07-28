-- ================================================================
-- RESIN SHELF LIFE: stop asking the operator when a bottle was opened.
--
-- resin_opened_at is what starts a tank's shelf life (2026-07-27_resin_tech.sql),
-- and it was a manual date field on the intake form. That is both friction and a
-- correctness hazard: the system can already tell, in the two cases that matter,
-- and a human-entered date can contradict what the volumes plainly say.
--
--   1. INTAKE. A tank entered holding LESS than a full bottle has demonstrably
--      been opened — you cannot have 800 ml of a 1000 ml bottle without opening
--      it. Recorded as opened on the spot.
--
--   2. FIRST DRAW. A tank entered full is sealed, and is stamped the moment its
--      remaining volume first drops — a completed print, a decant, a manual
--      stock correction, anything.
--
-- Both live in the database rather than in AssetsService for one reason: there
-- are five writers of a tank's volume (createResinTank, splitAsset,
-- JobsService.consumeResinTx, SimpleJobsService.markFailed, updateAssetStock) and
-- a rule enforced in one of them is a rule that silently doesn't hold in the
-- other four. The trigger is the sole owner of the automatic stamp.
--
-- An EXPLICIT resin_opened_at from the API still wins: both triggers only ever
-- fill a NULL. An operator who knows the real date can still record it.
--
-- Idempotent: safe to re-run. Requires 2026-07-27_resin_tech.sql first (it adds
-- the columns these triggers read).
-- ================================================================

BEGIN;

-- ---------------------------------------------------------------
-- 1. Intake: a partially-filled tank is already open
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_resin_opened_on_intake()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.resin_opened_at IS NULL
     AND NEW.resin_total_volume_ml IS NOT NULL
     AND NEW.resin_initial_volume_ml IS NOT NULL
     AND NEW.resin_initial_volume_ml < NEW.resin_total_volume_ml
  THEN
    NEW.resin_opened_at := CURRENT_DATE;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_resin_opened_on_intake ON public.asset_instances;
CREATE TRIGGER trg_resin_opened_on_intake
  BEFORE INSERT ON public.asset_instances
  FOR EACH ROW
  WHEN (NEW.asset_type = 'resin_tank')
  EXECUTE FUNCTION public.fn_resin_opened_on_intake();

-- ---------------------------------------------------------------
-- 2. First draw: a sealed tank opens the moment its volume drops
-- ---------------------------------------------------------------
-- Gated on a DECREASE, not on any change. markFailed restores a 'done' piece's
-- planned volume before deducting the measured waste, so an increase is a normal
-- event and must not be read as the bottle being opened.
CREATE OR REPLACE FUNCTION public.fn_resin_opened_on_first_draw()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.asset_instances ai
     SET resin_opened_at = CURRENT_DATE
   WHERE ai.asset_id = NEW.asset_id
     AND ai.asset_type = 'resin_tank'
     AND ai.resin_opened_at IS NULL;
  RETURN NULL; -- AFTER trigger; return value ignored
END
$$;

DROP TRIGGER IF EXISTS trg_resin_opened_on_first_draw ON public.asset_stock;
CREATE TRIGGER trg_resin_opened_on_first_draw
  AFTER UPDATE OF remaining_volume_ml ON public.asset_stock
  FOR EACH ROW
  WHEN (
    NEW.remaining_volume_ml IS NOT NULL
    AND OLD.remaining_volume_ml IS NOT NULL
    AND NEW.remaining_volume_ml < OLD.remaining_volume_ml
  )
  EXECUTE FUNCTION public.fn_resin_opened_on_first_draw();

-- ---------------------------------------------------------------
-- 3. Backfill the tanks already on the books
-- ---------------------------------------------------------------
-- Any existing tank that is demonstrably open — partially filled at intake, or
-- already drawn down below what it was filled with — but carries no date. Uses
-- the tank's own purchase date when known rather than today, so a bottle bought
-- months ago doesn't read as opened this morning; falls back to its creation date.
UPDATE public.asset_instances ai
   SET resin_opened_at = COALESCE(ai.resin_purchase_date, ai.created_at::date)
  FROM public.asset_stock ast
 WHERE ast.asset_id = ai.asset_id
   AND ai.asset_type = 'resin_tank'
   AND ai.resin_opened_at IS NULL
   AND (
     (ai.resin_total_volume_ml IS NOT NULL
      AND ai.resin_initial_volume_ml IS NOT NULL
      AND ai.resin_initial_volume_ml < ai.resin_total_volume_ml)
     OR
     (ast.remaining_volume_ml IS NOT NULL
      AND ai.resin_initial_volume_ml IS NOT NULL
      AND ast.remaining_volume_ml < ai.resin_initial_volume_ml)
   );

COMMIT;
