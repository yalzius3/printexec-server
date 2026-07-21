-- ================================================================
-- COMPANY HARD DELETE: make "delete a company" actually delete it.
--
-- Platform-admin deletion used to be a SOFT delete (companies.deleted_at):
-- the workspace was locked out but every row stayed in the database, so the
-- company kept appearing in the admin console — and when the same person
-- signed up again with the same email, the admin list showed BOTH the old
-- soft-deleted tenant and the new one. Deletion now removes the tenant for
-- real, which needs every child row to go with it.
--
-- Most tenant tables already declare ON DELETE CASCADE, but the original core
-- tables (orders, customers, printer_instances, …) predate this migrations
-- folder and were created without it, so a plain DELETE FROM companies would
-- fail on a foreign-key violation. This migration normalises that: every
-- foreign key pointing at companies(company_id) that currently does NOTHING
-- on delete (NO ACTION / RESTRICT) is rebuilt as ON DELETE CASCADE.
--
-- Deliberately preserved:
--   · ON DELETE SET NULL constraints (confdeltype = 'n') — e.g.
--     license_grants.redeemed_by_company_id, where the grant record must
--     outlive the company that redeemed it.
--   · Anything already CASCADE ('c') — left untouched.
--
-- Introspection-driven and idempotent: re-running finds nothing left to
-- convert. The DDL takes a brief ACCESS EXCLUSIVE lock per child table while
-- the constraint is swapped, so apply it during a quiet moment.
--
-- NOTE: after this, deleting a company is IRREVERSIBLE and takes all of its
-- orders, customers, jobs, assets, finance records and invoices with it. The
-- admin UI gates it behind a type-the-name confirmation.
-- ================================================================

BEGIN;

DO $$
DECLARE
  fk RECORD;
  cols TEXT;
  refcols TEXT;
BEGIN
  FOR fk IN
    SELECT c.oid,
           c.conname,
           c.conrelid::regclass AS child_table,
           c.confdeltype
      FROM pg_constraint c
      JOIN pg_class ref ON ref.oid = c.confrelid
      JOIN pg_namespace refns ON refns.oid = ref.relnamespace
     WHERE c.contype = 'f'
       AND refns.nspname = 'public'
       AND ref.relname = 'companies'
       -- 'a' = NO ACTION, 'r' = RESTRICT. Leave 'c' (cascade) and 'n' (set null).
       AND c.confdeltype IN ('a', 'r')
  LOOP
    -- Rebuild the same column mapping, only with ON DELETE CASCADE.
    SELECT string_agg(quote_ident(att.attname), ', ' ORDER BY u.ord)
      INTO cols
      FROM unnest((SELECT conkey FROM pg_constraint WHERE oid = fk.oid)) WITH ORDINALITY AS u(attnum, ord)
      JOIN pg_attribute att
        ON att.attrelid = (SELECT conrelid FROM pg_constraint WHERE oid = fk.oid)
       AND att.attnum = u.attnum;

    SELECT string_agg(quote_ident(att.attname), ', ' ORDER BY u.ord)
      INTO refcols
      FROM unnest((SELECT confkey FROM pg_constraint WHERE oid = fk.oid)) WITH ORDINALITY AS u(attnum, ord)
      JOIN pg_attribute att
        ON att.attrelid = (SELECT confrelid FROM pg_constraint WHERE oid = fk.oid)
       AND att.attnum = u.attnum;

    RAISE NOTICE 'company FK -> CASCADE: %.% (%)', fk.child_table, fk.conname, cols;

    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.child_table, fk.conname);
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%s) REFERENCES public.companies (%s) ON DELETE CASCADE',
      fk.child_table, fk.conname, cols, refcols
    );
  END LOOP;
END $$;

COMMIT;
