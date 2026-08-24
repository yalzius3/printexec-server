-- ================================================================
-- ORDERS: assigned personnel — which employee owns this order.
--
-- One nullable pointer from an order to a row in `users` (the company-employee
-- table StaffService reads: `SELECT ... FROM users WHERE company_id = $1`).
-- Null means "nobody assigned yet", which is the state every existing order
-- starts in and a legitimate resting state forever — an order is not required
-- to have an owner, so this is deliberately NOT NOT NULL and there is nothing
-- to backfill.
--
-- ── WHY `ON DELETE SET NULL` IS LOAD-BEARING ────────────────────────────────
-- StaffService.removeStaffMember does a HARD `DELETE FROM users` (it is not a
-- soft delete — it deletes the row and revokes their unused invites in the same
-- transaction). Under the default NO ACTION, this column would RESTRICT that
-- delete the moment the person owned a single order, and removing a departing
-- employee would fail with a foreign-key error naming a table the admin screen
-- never mentions. SET NULL is what keeps "remove this employee" a working
-- operation: their orders survive, unassigned, and can be handed to someone
-- else. This matches every other users(id) reference in the schema — see
-- `created_by` in finance_core, costing_variables, costing_presets, filament_waste.
--
-- ── WHY THE FK IS NOT COMPOSITE ─────────────────────────────────────────────
-- A plain `REFERENCES users(id)` guarantees the person EXISTS but not that they
-- belong to THIS company. The airtight version is a composite FK on
-- (assigned_personnel_id, company_id) -> users(id, company_id), and it is
-- deliberately not used here for two reasons:
--   1. `orders.company_id` is NOT NULL, so a composite `ON DELETE SET NULL`
--      would try to null BOTH columns and fail. Doing it right needs the
--      column-list form `ON DELETE SET NULL (assigned_personnel_id)`, which is
--      Postgres 15+ — a version dependency this file should not carry.
--   2. Cross-tenant assignment is already refused one layer up, by
--      OrdersService.assertPersonnelExists, which is exactly where
--      assertCustomerExists refuses a cross-tenant customer_id on the same
--      table. Consistency with the module beats a second, differently-shaped
--      guarantee.
-- If the composite form is ever wanted, it needs `UNIQUE (id, company_id)` on
-- users first.
--
-- Additive only; idempotent / safe to re-run. ONE transaction, so a failure
-- anywhere leaves the schema exactly as it was.
--
-- ⚠ LOCKING: scripts/run-sql-file.mjs sends this file as a single query, so
-- CREATE INDEX CONCURRENTLY is illegal inside it. A plain CREATE INDEX takes a
-- SHARE lock — SELECTs keep working, writes to `orders` block until the build
-- finishes. `orders` holds one row per order (not per piece, like order_pieces),
-- so this is sub-second on any realistic tenant. If it is somehow large, run the
-- statement by hand outside a transaction with CONCURRENTLY.
-- ================================================================

BEGIN;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS assigned_personnel_id UUID
    REFERENCES public.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.orders.assigned_personnel_id IS
  'The company employee (users.id) responsible for this order. NULL = unassigned, which is both the initial and a permanent legal state. ON DELETE SET NULL so removing a staff member does not block on their orders; same-company membership is asserted by OrdersService.assertPersonnelExists, not by the FK.';

-- ── INDEX ───────────────────────────────────────────────────────────────────
-- Two access paths need it:
--   1. "Show me what <person> is on" — a company-scoped filter on the column.
--   2. The FK itself. Deleting a users row makes Postgres find every referencing
--      order to null it out; with no index that is a full scan of `orders` per
--      staff removal.
-- Partial (WHERE NOT NULL) because unassigned orders are the overwhelming
-- majority at rollout and none of them are ever the answer to either query.
--
-- DUPLICATE GUARD, following 2026-08-17_jobs_queue_read_indexes.sql: check
-- pg_index for an index whose LEADING columns already cover this path rather
-- than trusting the NAME, since this schema carries base indexes that are not
-- defined in this repo (2026-07-09_index_dedupe.sql exists because of exactly
-- that).
--
-- Two details copied from that file for the same reasons it gives:
--   · indkey is read via string_to_array(indkey::text, ' ') rather than
--     subscripted directly. indkey is an int2vector whose subscripts are
--     0-based, unlike every normal Postgres array. Splitting the text rendering
--     gives a plain text[] with the standard lower bound of 1, so the ordinals
--     below are unambiguous on any server.
--   · The comparison is on ATTNUM, not attname. attname is type `name`, and
--     `array_agg(attname) = ARRAY['company_id', ...]` is name[] = text[], for
--     which there is no operator — that is a 42883 at run time, not a typo the
--     eye catches.
--   · indnkeyatts (PG 11+) excludes INCLUDE columns, so (company_id) INCLUDE
--     (assigned_personnel_id) is correctly NOT treated as a match.
--
-- Only a NON-PARTIAL match counts as covering. An existing partial index could
-- have any predicate, and deciding whether it covers this one means comparing
-- predicate expressions — which would mean guessing how Postgres renders mine.
-- Creating one redundant small partial index is the cheaper mistake than
-- skipping a needed one, so the guard stays conservative and says so.
DO $$
DECLARE
  col_company   int2;
  col_personnel int2;
  already       boolean;
BEGIN
  IF to_regclass('public.orders') IS NULL THEN
    RAISE NOTICE 'public.orders missing -- skipping index.';
    RETURN;
  END IF;

  SELECT a.attnum INTO col_company FROM pg_attribute a
   WHERE a.attrelid = 'public.orders'::regclass AND a.attname = 'company_id';
  SELECT a.attnum INTO col_personnel FROM pg_attribute a
   WHERE a.attrelid = 'public.orders'::regclass AND a.attname = 'assigned_personnel_id';

  IF col_company IS NULL OR col_personnel IS NULL THEN
    RAISE NOTICE 'orders.company_id/assigned_personnel_id missing -- skipping index.';
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM pg_index i
     WHERE i.indrelid = 'public.orders'::regclass
       AND i.indnkeyatts >= 2
       AND i.indpred IS NULL
       AND (string_to_array(i.indkey::text, ' '))[1]::int = col_company
       AND (string_to_array(i.indkey::text, ' '))[2]::int = col_personnel
  ) INTO already;

  IF already THEN
    RAISE NOTICE 'orders already has an index leading (company_id, assigned_personnel_id) -- skipping.';
  ELSE
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_orders_assigned_personnel
               ON public.orders (company_id, assigned_personnel_id)
               WHERE assigned_personnel_id IS NOT NULL';
  END IF;
END $$;

COMMIT;
