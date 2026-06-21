-- ================================================================
-- Persist the per-piece costing inputs (filament grams per slot, print
-- minutes, failure %) so they survive save / reopen. One nullable JSONB
-- blob: { grams: string[], time: string, failure: string }.
-- Additive, idempotent.
-- ================================================================

BEGIN;

ALTER TABLE public.order_pieces
  ADD COLUMN IF NOT EXISTS cost_inputs JSONB;

COMMIT;
