-- ================================================================
-- PIECE COST: a single nullable money column on order_pieces.
-- Additive only — no behaviour changes elsewhere. Safe to re-run.
-- ================================================================

BEGIN;

-- The per-piece cost. NUMERIC(12,2) = money with cents; nullable so existing
-- pieces (and any not yet priced) simply have no cost.
ALTER TABLE public.order_pieces
  ADD COLUMN IF NOT EXISTS cost NUMERIC(12, 2);

-- Guard against negatives without forcing a value (NULL passes the check).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'order_pieces_cost_nonnegative_check'
      AND conrelid = 'public.order_pieces'::regclass
  ) THEN
    ALTER TABLE public.order_pieces
      ADD CONSTRAINT order_pieces_cost_nonnegative_check
        CHECK (cost IS NULL OR cost >= 0);
  END IF;
END $$;

COMMIT;
