-- ================================================================
-- Global slicer-file storage mode (per company).
--
-- Two upload modes, chosen once per company:
--   store_full_slicer_files = true  (default) → full slicer files are uploaded
--       and stored, exactly as before.
--   store_full_slicer_files = false → metadata-only: the client parses the
--       slicer header/footer LOCALLY and sends only that; the heavy file is
--       never uploaded or stored ("solely the client's responsibility").
--
-- Additive + backward-compatible: NOT NULL with a default, so old code that
-- never reads the column is unaffected and existing rows default to the
-- current (full-storage) behavior. Safe to re-run.
-- ================================================================

BEGIN;

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS store_full_slicer_files BOOLEAN NOT NULL DEFAULT true;

COMMIT;
