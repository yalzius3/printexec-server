-- ================================================================
-- Per-piece STL thumbnail cache.
--
-- A small PNG preview of the piece's STL, rendered in the browser (three.js)
-- and uploaded like any other file; this column stores the served URL so every
-- viewer — and every reload — shares one cached image instead of re-rendering.
--
-- Additive + backward-compatible: plain nullable TEXT with no default. Server
-- code projects NULL under the same alias until this runs (JobsService gates the
-- projection on a live information_schema check), so shipping the code before
-- applying this migration is safe. Only pieces WITH an STL ever get a value.
-- Safe to re-run.
-- ================================================================

BEGIN;

ALTER TABLE public.order_pieces
  ADD COLUMN IF NOT EXISTS stl_thumbnail_url TEXT;

COMMIT;
