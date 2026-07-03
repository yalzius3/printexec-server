-- ================================================================
-- ORDERS: guest checkout fields.
--
-- Adds guest_name / guest_email / guest_phone so an order can be created
-- without picking an existing CRM customer, while still capturing enough
-- contact info to auto-resolve (or auto-create) a real customer record at
-- confirm time. Additive only.
--
-- The CHECK constraint is added NOT VALID: existing orders created before
-- this feature (customer_id IS NULL and no guest fields, e.g. old drafts
-- from the 2026-06-22_orders_customer_optional.sql era) would violate the
-- new rule and must NOT block this migration. Every INSERT/UPDATE from now
-- on is enforced immediately (NOT VALID still applies to new writes -- it
-- only skips checking PRE-EXISTING rows). Deliberately left un-VALIDATEd
-- (see bottom) -- not required for the feature to work, only for
-- query-planner guarantees this feature doesn't need. Mirrors the same
-- NOT VALID pattern already used in 2026-06-30_metadata_driven_readiness.sql.
--
-- Idempotent: safe to re-run (ADD COLUMN IF NOT EXISTS + drop/re-add constraint).
-- ================================================================

BEGIN;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS guest_name  TEXT,
  ADD COLUMN IF NOT EXISTS guest_email TEXT,
  ADD COLUMN IF NOT EXISTS guest_phone TEXT;

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS chk_orders_customer_or_guest;

ALTER TABLE public.orders
  ADD CONSTRAINT chk_orders_customer_or_guest
  CHECK (
    customer_id IS NOT NULL
    OR (
      guest_name IS NOT NULL
      AND (guest_email IS NOT NULL OR guest_phone IS NOT NULL)
    )
  ) NOT VALID;

COMMIT;

-- Intentionally not run as part of this migration -- see comment above.
-- ALTER TABLE public.orders VALIDATE CONSTRAINT chk_orders_customer_or_guest;
