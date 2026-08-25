-- ================================================================
-- ORDER PURGE: a transaction-scoped escape from ledger immutability.
--
-- "Cancel and delete" erases an order completely — rows, files, and its
-- financial record — so that nothing of it remains. Everything except the last
-- of those already worked. This file is about the last of those.
--
-- ── WHAT STOPS IT TODAY ─────────────────────────────────────────────────────
-- finance_core installs two BEFORE triggers that make posted accounting
-- immutable, and they are correct:
--   · trg_journal_lines_immutable    — any UPDATE or DELETE of a line whose
--                                      entry is 'posted' raises.
--   · trg_journal_entries_immutable  — DELETE of a posted entry raises, unless
--                                      the companies row is already gone (the
--                                      tenant-teardown cascade).
-- An issued invoice posts a journal entry, so purging such an order hits those
-- triggers and fails. The whole point of them is that an operator cannot quietly
-- rewrite history, and that remains true after this migration.
--
-- ── THE ESCAPE, AND WHY IT IS SHAPED LIKE THIS ──────────────────────────────
-- The schema ALREADY carries a precedent: journal_entries_block_posted_mutation
-- lets a delete through when the tenant itself is being torn down. That is the
-- same shape of exception this needs — a deliberate, whole-document destruction
-- rather than an edit — so this adds a second one of exactly that kind:
--
--     current_setting('printexec.purge_order', true) = 'on'
--
-- Set with `SET LOCAL` inside the purge transaction (OrderPurge.purgeOrderTx),
-- which means:
--   · It is TRANSACTION-scoped. COMMIT or ROLLBACK clears it; there is no way
--     to leave it switched on.
--   · It cannot leak across a connection pool. SET LOCAL binds to the
--     transaction on one client, not to the session or the server.
--   · It cannot be reached by accident. Nothing else in the codebase sets it,
--     and an ordinary DELETE without it still raises exactly as before.
--
-- `current_setting(..., true)` — the `true` is missing_ok. Without it, reading
-- an unset GUC RAISES, which would turn every ordinary journal delete into an
-- error instead of leaving today's behaviour alone.
--
-- ── WHAT IS NOT WEAKENED ────────────────────────────────────────────────────
-- UPDATE is untouched on both triggers. A posted entry's date, number, source,
-- reversal link, company and status stay frozen, and a posted entry's lines
-- still cannot be edited, purge or no purge. The only new power is deleting a
-- WHOLE document, which is what "as if it never happened" means and is also why
-- the trial balance survives it: a journal entry balances on its own, so
-- removing all of its lines together leaves the remaining ledger balanced.
--
-- What it does NOT survive is history. Erasing an issued invoice erases revenue
-- and receivable that were really recorded. If a payment was applied to it, the
-- payment is a document of its own and is deliberately NOT deleted — only its
-- application to this invoice is — so the money still exists on the books as an
-- unapplied receipt. That is a real consequence of the feature, not a defect in
-- it, and the API reports the counts so an operator can see what went.
--
-- Idempotent: CREATE OR REPLACE FUNCTION, and the triggers are recreated
-- pointing at the same names. Safe to re-run.
-- ================================================================

BEGIN;

-- ── journal_lines ───────────────────────────────────────────────────────────
-- Identical to the finance_core original except for the purge branch. Note the
-- branch sits INSIDE the posted check, so nothing changes for a draft entry.
CREATE OR REPLACE FUNCTION public.journal_lines_block_posted_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  entry_status TEXT;
BEGIN
  SELECT status INTO entry_status
  FROM public.journal_entries
  WHERE entry_id = OLD.entry_id;

  IF entry_status = 'posted' THEN
    -- An order purge destroys whole documents, lines and all. Deleting is
    -- allowed here; editing a posted line never is, purge or not.
    IF NOT (TG_OP = 'DELETE'
            AND current_setting('printexec.purge_order', true) = 'on') THEN
      RAISE EXCEPTION 'Journal lines of a posted entry are immutable (entry %).', OLD.entry_id;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_journal_lines_immutable ON public.journal_lines;
CREATE TRIGGER trg_journal_lines_immutable
  BEFORE UPDATE OR DELETE ON public.journal_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.journal_lines_block_posted_mutation();

-- ── journal_entries ─────────────────────────────────────────────────────────
-- Identical to the finance_core original except that the DELETE guard now has
-- a second exception beside the tenant-teardown one it already had.
CREATE OR REPLACE FUNCTION public.journal_entries_block_posted_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Allow the tenant-teardown cascade (company row already deleted in this
    -- transaction) and the order purge (SET LOCAL, one transaction, see the
    -- header); block every other delete of posted history.
    IF OLD.status = 'posted'
       AND current_setting('printexec.purge_order', true) IS DISTINCT FROM 'on'
       AND EXISTS (SELECT 1 FROM public.companies WHERE company_id = OLD.company_id) THEN
      RAISE EXCEPTION 'Posted journal entries cannot be deleted -- post a reversal instead (entry %).', OLD.entry_id;
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE: a posted entry's accounting substance is frozen. Memo stays
  -- editable (annotation, not accounting data). UNCHANGED by the purge — an
  -- entry can be destroyed whole, never quietly rewritten.
  IF OLD.status = 'posted' THEN
    IF NEW.status <> 'posted'
       OR NEW.entry_date IS DISTINCT FROM OLD.entry_date
       OR NEW.entry_number IS DISTINCT FROM OLD.entry_number
       OR NEW.source_type IS DISTINCT FROM OLD.source_type
       OR NEW.source_id IS DISTINCT FROM OLD.source_id
       OR NEW.reverses_entry_id IS DISTINCT FROM OLD.reverses_entry_id
       OR NEW.company_id IS DISTINCT FROM OLD.company_id THEN
      RAISE EXCEPTION 'Posted journal entries are immutable -- post a reversal instead (entry %).', OLD.entry_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_journal_entries_immutable ON public.journal_entries;
CREATE TRIGGER trg_journal_entries_immutable
  BEFORE UPDATE OR DELETE ON public.journal_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.journal_entries_block_posted_mutation();

COMMIT;
