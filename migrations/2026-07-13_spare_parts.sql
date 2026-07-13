-- ================================================================
-- SPARE PARTS: a fourth first-class asset type.
--
-- "Materials & Accessories → Spare Parts" tracks loose replacement pieces —
-- fans, belts, PTFE tubes, extruder gears, any random part worth keeping on
-- the books. A spare part is deliberately the SIMPLEST asset shape we have:
-- like a nozzle it is a direct asset_instances + asset_stock pair (no
-- reference-catalog table), and it reuses the existing generic columns:
--
--   purchase_price  -> the per-unit price (page value total / overview value)
--   notes           -> the optional freeform description
--   location        -> optional physical spot, editable in the detail window
--
-- Only its identity needs new storage:
--
--   1. spare_part_name  TEXT -- required by the API on create; the display name
--   2. spare_part_brand TEXT -- optional manufacturer
--
-- Both columns are additive + nullable, so existing rows are unaffected.
--
--   3. asset_type must now accept 'spare_part' on asset_instances (and on
--      asset_history, which logs the same discriminator). The base tables
--      predate this migrations folder, so the constraint shape isn't pinned
--      in-repo: the DO block below handles a TEXT column guarded by a CHECK
--      (any check that enumerates the three known types is rebuilt to the
--      canonical four-value list, keeping its name), an enum column (new
--      label appended), or no constraint at all (nothing to do).
--
-- No new indexes: list/overview queries filter on (company_id, asset_type),
-- already covered by idx_asset_instances_company_type.
--
-- Idempotent: safe to re-run.
-- ================================================================

BEGIN;

-- ---------------------------------------------------------------
-- 1 + 2. Identity columns
-- ---------------------------------------------------------------
ALTER TABLE public.asset_instances
  ADD COLUMN IF NOT EXISTS spare_part_name TEXT;

ALTER TABLE public.asset_instances
  ADD COLUMN IF NOT EXISTS spare_part_brand TEXT;

-- ---------------------------------------------------------------
-- 3. Allow 'spare_part' wherever asset_type is constrained
-- ---------------------------------------------------------------
DO $$
DECLARE
  tbl TEXT;
  col RECORD;
  con RECORD;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['asset_instances', 'asset_history'] LOOP
    SELECT data_type, udt_name INTO col
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = tbl AND column_name = 'asset_type';
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    IF col.data_type = 'USER-DEFINED' THEN
      -- Enum column: append the new label if it isn't there yet (both tables
      -- may share one enum type — the second pass then finds it already added).
      IF NOT EXISTS (
        SELECT 1
          FROM pg_enum e
          JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = col.udt_name AND e.enumlabel = 'spare_part'
      ) THEN
        EXECUTE format('ALTER TYPE public.%I ADD VALUE %L', col.udt_name, 'spare_part');
      END IF;
    ELSE
      -- TEXT column: rebuild only the CHECKs that enumerate the known asset
      -- types (matching all three original values keeps conditional checks
      -- that merely mention asset_type out of harm's way) and don't already
      -- allow 'spare_part'. Re-added NOT VALID: it still constrains every NEW
      -- write (all the app ever needed from it) but skips re-validating old
      -- rows, so a stray legacy value some earlier design may have logged can
      -- never abort this migration.
      FOR con IN
        SELECT conname
          FROM pg_constraint
         WHERE conrelid = format('public.%I', tbl)::regclass
           AND contype = 'c'
           AND pg_get_constraintdef(oid) ILIKE '%asset_type%'
           AND pg_get_constraintdef(oid) LIKE '%filament_spool%'
           AND pg_get_constraintdef(oid) LIKE '%nozzle%'
           AND pg_get_constraintdef(oid) LIKE '%resin_tank%'
           AND pg_get_constraintdef(oid) NOT LIKE '%spare_part%'
      LOOP
        EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', tbl, con.conname);
        EXECUTE format(
          'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (asset_type IN (%L, %L, %L, %L)) NOT VALID',
          tbl, con.conname, 'filament_spool', 'nozzle', 'resin_tank', 'spare_part'
        );
      END LOOP;
    END IF;
  END LOOP;
END
$$;

COMMIT;
