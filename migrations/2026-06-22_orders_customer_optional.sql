-- ================================================================
-- ORDERS: customer becomes optional at creation.
-- Orders can now be created with no customer attached and have one
-- assigned later (at confirmation). Drops the NOT NULL constraint on
-- orders.customer_id. The existing foreign key stays — a nullable FK
-- column is valid. Additive only; safe to re-run (DROP NOT NULL on an
-- already-nullable column is a no-op).
-- ================================================================

BEGIN;

ALTER TABLE public.orders
  ALTER COLUMN customer_id DROP NOT NULL;

COMMIT;
