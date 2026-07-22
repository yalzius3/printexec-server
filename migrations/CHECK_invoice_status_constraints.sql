-- READ-ONLY diagnostic. Run this BEFORE re-running
-- 2026-07-23_invoice_drafts_custom_tiers.sql to see exactly which CHECK
-- constraints exist on subscription_invoices and which ones that migration
-- will drop. It changes nothing.
--
-- Expect: will_be_dropped = true for the `status` constraint ONLY.
-- If subscription_invoices_email_status_check is missing entirely, the failed
-- first run committed before erroring — the migration re-creates it for you.

SELECT
  con.conname                                   AS constraint_name,
  pg_get_constraintdef(con.oid)                 AS definition,
  (con.conkey = ARRAY[(
     SELECT att.attnum FROM pg_attribute att
      WHERE att.attrelid = 'public.subscription_invoices'::regclass
        AND att.attname = 'status'
   )])                                          AS will_be_dropped
FROM pg_constraint con
WHERE con.conrelid = 'public.subscription_invoices'::regclass
  AND con.contype = 'c'
ORDER BY 3 DESC, 1;
