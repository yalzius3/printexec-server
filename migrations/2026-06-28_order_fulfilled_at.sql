-- ================================================================
-- ORDERS: fulfilled_at anchor + auto-maintenance trigger.
--
-- orders.status = 'fulfilled' is a DERIVED rollup (see common/cascade.ts) and
-- is NOT sticky: it can flip back to 'completed' / 'ready_for_shipping' / etc.
-- if a piece's fulfilment_status changes. A time-based retention policy needs a
-- stable anchor for *when* the order entered the fulfilled state.
--
-- A BEFORE trigger maintains the column from EVERY write path (the cascade
-- recompute, the manual status PATCH in orders.service, the jobs flows) so no
-- application code has to remember to stamp it:
--   * entering 'fulfilled'  -> fulfilled_at = now()
--   * staying  'fulfilled'  -> fulfilled_at unchanged
--   * leaving  'fulfilled'  -> fulfilled_at = NULL   (retention timer resets)
--
-- Additive only; idempotent / safe to re-run.
-- ================================================================

BEGIN;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS fulfilled_at timestamptz;

-- Start the clock for orders already sitting in 'fulfilled' at migration time.
-- We have no historical transition timestamp, so anchor at "now": this gives
-- existing fulfilled orders a full retention window instead of making their
-- files instantly eligible for deletion on first sweep.
UPDATE public.orders
   SET fulfilled_at = now()
 WHERE status = 'fulfilled'
   AND fulfilled_at IS NULL;

CREATE OR REPLACE FUNCTION public.orders_maintain_fulfilled_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'fulfilled' THEN
    -- Stamp once on entry; preserve the original anchor while it stays fulfilled.
    IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'fulfilled' THEN
      NEW.fulfilled_at := now();
    ELSE
      NEW.fulfilled_at := COALESCE(NEW.fulfilled_at, OLD.fulfilled_at);
    END IF;
  ELSE
    -- Any non-fulfilled state clears the anchor so the timer resets cleanly.
    NEW.fulfilled_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_orders_maintain_fulfilled_at ON public.orders;
CREATE TRIGGER trg_orders_maintain_fulfilled_at
  BEFORE INSERT OR UPDATE OF status ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.orders_maintain_fulfilled_at();

COMMIT;
