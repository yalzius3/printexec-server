-- ================================================================
-- ORDERS: expand the allowed status set with the post-production
-- fulfilment lifecycle.
--
-- Adds four new statuses to orders.status:
--   ready_for_shipping, out_for_shipping, returned, fulfilled
--
-- Additive only — no existing rows change, and NO transition logic is
-- introduced here (the application still drives status changes; the
-- allowed transitions between these new states are defined separately).
-- Idempotent / safe to re-run.
-- ================================================================

BEGIN;

-- Drop whatever CHECK constraint currently guards orders.status (its name is
-- not assumed — the original schema may have auto-named it), then re-add the
-- canonical one with the expanded set. Done dynamically so this works whether
-- the constraint is named orders_status_check or something else, or absent.
DO $$
DECLARE
  con_name text;
BEGIN
  FOR con_name IN
    SELECT con.conname
    FROM pg_constraint con
    WHERE con.conrelid = 'public.orders'::regclass
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE public.orders DROP CONSTRAINT %I', con_name);
  END LOOP;
END $$;

ALTER TABLE public.orders
  ADD CONSTRAINT orders_status_check
    CHECK (status IN (
      'draft',
      'confirmed',
      'in_progress',
      'completed',
      'ready_for_shipping',
      'out_for_shipping',
      'returned',
      'fulfilled',
      'cancelled'
    ));

COMMIT;
