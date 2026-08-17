-- ================================================================
-- FILAMENT INTAKE BATCHES (lots)
--
-- At a hundred spools every few days, inspecting and recording each spool
-- individually is most of the intake work. A batch is the unit an operator
-- actually handles: one ×N intake of ONE filament reference becomes one lot,
-- and every spool in it carries a badge saying which lot it came from.
--
-- Deliberate shape:
--
--   * A batch has NO status. Spools have states (available / in use / empty /
--     damaged); the lot they arrived in does not. There is nothing to
--     transition, so there is no status column and no NFA.
--
--   * A batch is ONE filament type. filament_ref_id is NOT NULL, which makes
--     that structural rather than a convention someone has to remember. It is
--     also what keeps this filament-only: a resin/nozzle/spare-part intake has
--     no reference to put here and therefore cannot form a batch. (If batches
--     are ever wanted for the other consumables, this column becomes nullable
--     alongside an asset_type discriminator — not before.)
--
--   * The NAME is free text and defaults to the intake date, so the common case
--     costs the operator nothing; "lab batch", "1", "Aug17 lot B" all work.
--     Names are NOT globally unique — see the uniqueness rule below.
--
--   * The NUMBER (B-2026-00001) is the stable identifier. Minted per tenant per
--     year from an atomic counter, exactly like order_number_sequences.
--
-- UNIQUENESS RULE: (company, filament reference, lower(name)).
--   Re-using a name for the SAME filament type JOINS that batch — this is how
--   "twenty more of the black PLA+ went into today's lot" works, and it is why
--   two ×20 intakes of one type on one day read as one batch of 40 rather than
--   two identical-looking lots. Re-using a name for a DIFFERENT type mints a
--   separate batch with the same name, which is correct: a delivery of five
--   materials is five type-pure lots that all answer to "2026-08-17" when
--   searched. The unique index is what makes the join safe under concurrency.
--
-- Wholly additive. Existing spools keep batch_id NULL and render exactly as
-- they do today; nothing is backfilled, because a batch records how a delivery
-- was actually received and inventing lots for historical rows would be fiction.
--
-- Idempotent: safe to re-run.
-- ================================================================

BEGIN;

-- ---------------------------------------------------------------
-- 1. asset_batch_sequences — atomic per-tenant, per-year counter
-- ---------------------------------------------------------------
-- Bumped with INSERT ... ON CONFLICT DO UPDATE ... RETURNING, whose conflict
-- path takes a row lock; two concurrent intakes can therefore never be handed
-- the same value. A new year has no row yet, so it starts back at 1.
CREATE TABLE IF NOT EXISTS public.asset_batch_sequences (
  company_id UUID    NOT NULL REFERENCES public.companies(company_id) ON DELETE CASCADE,
  year       INTEGER NOT NULL,
  last_value BIGINT  NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, year)
);

-- ---------------------------------------------------------------
-- 2. asset_batches
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.asset_batches (
  batch_id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID        NOT NULL REFERENCES public.companies(company_id) ON DELETE CASCADE,
  -- Business-facing lot number: B-2026-00001. Unique per tenant.
  batch_number    TEXT        NOT NULL,
  -- Operator-facing label. Defaults to the intake date at the API layer, never
  -- here: "today" belongs to the request's clock, not the database's.
  name            TEXT        NOT NULL,
  -- The one filament type this lot consists of. NOT NULL by design (above).
  filament_ref_id UUID        NOT NULL REFERENCES public.filament_reference(filament_ref_id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hard backstop for the business identifier.
CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_batches_company_number
  ON public.asset_batches (company_id, batch_number);

-- The join probe AND the invariant, in one index: looking up "does this lot
-- already exist for this type?" is the same key that forbids a duplicate.
-- lower() so "Aug17" and "aug17" are the same lot to a human and to Postgres.
CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_batches_company_ref_name
  ON public.asset_batches (company_id, filament_ref_id, lower(name));

-- Search by name across every type ("show me everything from 2026-08-17"), and
-- the batch list's newest-first ordering.
CREATE INDEX IF NOT EXISTS idx_asset_batches_company_created
  ON public.asset_batches (company_id, created_at DESC);

COMMENT ON TABLE public.asset_batches IS
  'Filament intake lots: one ×N spool intake of one filament reference. Stateless by design — spools carry status, lots do not. Unique on (company, reference, lower(name)) so re-using a name tops the lot up instead of cloning it.';

-- ---------------------------------------------------------------
-- 3. asset_instances.batch_id
-- ---------------------------------------------------------------
-- ON DELETE SET NULL, not CASCADE: a batch is a label on physical inventory.
-- Deleting the label must never delete the spools sitting on the shelf.
ALTER TABLE public.asset_instances
  ADD COLUMN IF NOT EXISTS batch_id UUID
    REFERENCES public.asset_batches(batch_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_asset_instances_batch_id
  ON public.asset_instances (batch_id)
  WHERE batch_id IS NOT NULL;

COMMENT ON COLUMN public.asset_instances.batch_id IS
  'The intake lot this spool arrived in. NULL for singly-entered spools and for every asset type other than filament_spool.';

COMMIT;
