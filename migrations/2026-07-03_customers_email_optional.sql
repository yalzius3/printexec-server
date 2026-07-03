-- ================================================================
-- CUSTOMERS: email becomes optional.
--
-- Guest-order resolution can now create phone-only customers (no email).
-- customers predates the migrations folder (created directly in Supabase),
-- so the exact NOT NULL/index names aren't recoverable from static
-- inspection -- DROP NOT NULL is idempotent and safe regardless (a no-op if
-- the column is already nullable). Postgres unique indexes already treat
-- multiple NULLs as non-conflicting, so no index changes are needed to
-- allow several phone-only customers to coexist.
--
-- The "email OR phone required" rule is enforced at the app layer only
-- (CustomersService / customers.schemas.ts), not as a DB CHECK constraint,
-- since customers rows are only ever written through CustomersService.
-- ================================================================

BEGIN;

ALTER TABLE public.customers
  ALTER COLUMN email DROP NOT NULL;

COMMIT;
