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
-- Additive only; idempotent / safe to re-run.
-- ================================================================

BEGIN;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS assigned_personnel_id UUID
    REFERENCES public.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.orders.assigned_personnel_id IS
  'The company employee (users.id) responsible for this order. NULL = unassigned, which is both the initial and a permanent legal state. ON DELETE SET NULL so removing a staff member does not block on their orders; same-company membership is asserted by OrdersService.assertPersonnelExists, not by the FK.';

COMMIT;

-- ── INDEX ───────────────────────────────────────────────────────────────────
-- Two access paths need it:
--   1. "Show me what <person> is on" — a company-scoped filter on the column.
--   2. The FK itself. Deleting a users row makes Postgres find every referencing
--      order to null it out; with no index that is a full scan of `orders` per
--      staff removal.
-- Partial (WHERE NOT NULL) because unassigned orders are the overwhelming
-- majority at rollout and none of them are ever the answer to either query.
--
-- DUPLICATE GUARD, matching the house style in
-- 2026-08-17_jobs_queue_read_indexes.sql: check pg_index for an index whose
-- LEADING columns already cover this path rather than trusting the NAME, since
-- this schema carries base indexes that are not defined in this repo.
--
-- LOCKING: this file is sent as ONE implicit transaction by
-- scripts/run-sql-file.mjs, so CONCURRENTLY is illegal inside it. A plain
-- CREATE INDEX takes a SHARE lock — SELECTs keep working, writes to `orders`
-- block until the build finishes. `orders` is orders of magnitude smaller than
-- `order_pieces` (one row per order, not per piece), so this is sub-second on
-- any realistic tenant. If it is somehow large, run it by hand outside a
-- transaction with CONCURRENTLY:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_assigned_personnel
--     ON public.orders (company_id, assigned_personnel_id)
--     WHERE assigned_personnel_id IS NOT NULL;
DO $$
BEGIN
  IF to_regclass('public.orders') IS NULL THEN
    RAISE NOTICE 'public.orders missing - skipping index.';
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
     WHERE t.relname = 'orders'
       AND t.relnamespace = 'public'::regnamespace
       -- Leading two columns are (company_id, assigned_personnel_id), in that
       -- order, whatever the index is called.
       AND (
         SELECT array_agg(a.attname ORDER BY k.ord)
           FROM unnest(i.indkey[0:1]) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a
             ON a.attrelid = i.indrelid AND a.attnum = k.attnum
       ) = ARRAY['company_id', 'assigned_personnel_id']
  ) THEN
    RAISE NOTICE 'An index already leads with (company_id, assigned_personnel_id) - skipping.';
  ELSE
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_orders_assigned_personnel
               ON public.orders (company_id, assigned_personnel_id)
               WHERE assigned_personnel_id IS NOT NULL';
  END IF;
END
$$;
