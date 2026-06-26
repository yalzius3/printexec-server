-- ================================================================
-- ORDER PIECES: per-piece shipping / fulfilment lifecycle.
--
-- A piece's production status (order_pieces.status) stays untouched — a
-- shipped/fulfilled piece is still status = 'done' for every execution,
-- scheduling and analytics query. The shipping lifecycle is tracked on a
-- SEPARATE, orthogonal column so it never disturbs the production state
-- machine.
--
-- fulfilment_status flow (forward only), only meaningful once a piece is done:
--   none -> ready_for_shipping -> out_for_shipping -> fulfilled
--   none -> fulfilled                         (on-the-spot pickup: Done -> Fulfilled)
--
-- Additive only; safe to re-run.
-- ================================================================

BEGIN;

ALTER TABLE public.order_pieces
  ADD COLUMN IF NOT EXISTS fulfilment_status TEXT NOT NULL DEFAULT 'none';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'order_pieces_fulfilment_status_check'
      AND conrelid = 'public.order_pieces'::regclass
  ) THEN
    ALTER TABLE public.order_pieces
      ADD CONSTRAINT order_pieces_fulfilment_status_check
        CHECK (fulfilment_status IN (
          'none',
          'ready_for_shipping',
          'out_for_shipping',
          'fulfilled'
        ));
  END IF;
END $$;

COMMIT;
