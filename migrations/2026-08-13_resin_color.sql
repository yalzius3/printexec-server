-- ================================================================
-- RESIN COLOUR: make a tank's colour a matchable fact, not just a label.
--
-- A resin print is SINGLE-colour by construction — there is no AMS, no tool
-- change, no per-slot split; the part comes out the colour of the liquid in the
-- vat. So resin never touches the multicolor machinery (order_piece_color_slots,
-- requires_multicolor, required_multicolor_capable all stay false/empty for it).
-- But it is emphatically colour-VIABLE: a customer orders a blue part, and only
-- a blue tank can produce it.
--
-- Until now colour existed on both sides and was compared on NEITHER:
--
--   * asset_instances.resin_color / resin_hex were captured at intake and used
--     only to build a display label ("Anycubic ABS-Like Clear").
--   * order_pieces.required_color was already written for resin rows by the
--     bulk piece grid.
--
-- so the assign picker happily offered a yellow tank for a blue print, and
-- auto-assign picked whichever tank merely had the volume. Colour is now a
-- filter on both paths (see SimpleJobsService.availability / assign /
-- autoSchedule).
--
-- What this migration actually does:
--
--   1. Guarantees the two tank columns exist. On every environment that ran the
--      original resin stub they already do — the service layer has read them
--      since 2026-07-27 — but they were never in a migration file, so a fresh
--      database built from migrations/ alone would not have them. That gap is
--      the reason this is written defensively rather than assumed.
--   2. Normalises whitespace-only colours to NULL, because the matcher treats
--      NULL as "untinted / unspecified → matches anything" and a stray ' '
--      would otherwise read as a real colour that matches nothing.
--   3. Adds the lookup index the colour-filtered tank query wants.
--
-- Idempotent and additive: safe to re-run, and safe to apply BEFORE the API
-- that uses it is deployed.
-- ================================================================

BEGIN;

-- 1. The two colour facts a tank carries. resin_color is the human name the
--    operator matches on ("Smoky Black"); resin_hex is the optional swatch for
--    the UI and is never used for matching — two tanks can both be "black" with
--    different hexes, and an operator naming them both black means they are
--    interchangeable for a job that asked for black.
ALTER TABLE public.asset_instances
  ADD COLUMN IF NOT EXISTS resin_color TEXT,
  ADD COLUMN IF NOT EXISTS resin_hex   TEXT;

-- 2. '' and '   ' must not survive as "a colour". The matcher's wildcard rule
--    keys off NULL, so a blank string would make a tank match nothing at all
--    instead of everything.
UPDATE public.asset_instances
   SET resin_color = NULL
 WHERE asset_type = 'resin_tank'
   AND resin_color IS NOT NULL
   AND TRIM(resin_color) = '';

UPDATE public.asset_instances
   SET resin_hex = NULL
 WHERE asset_type = 'resin_tank'
   AND resin_hex IS NOT NULL
   AND TRIM(resin_hex) = '';

-- Same rule on the demand side: a piece whose required_color is blank means
-- "any colour", and must not be stored as a colour that matches no tank.
UPDATE public.order_pieces
   SET required_color = NULL
 WHERE required_color IS NOT NULL
   AND TRIM(required_color) = '';

-- 3. Tank lookup is "give me the resin tanks for this company, by colour".
--    Partial on asset_type so it stays small — resin tanks are a minority of
--    asset_instances, which also holds every spool, nozzle and spare part.
--    LOWER() because matching is case-insensitive ("Black" = "black"), mirroring
--    the sameColor() helper the FDM colour-slot matcher has always used.
CREATE INDEX IF NOT EXISTS idx_asset_instances_resin_color
  ON public.asset_instances (company_id, LOWER(TRIM(resin_color)))
  WHERE asset_type = 'resin_tank';

COMMIT;
