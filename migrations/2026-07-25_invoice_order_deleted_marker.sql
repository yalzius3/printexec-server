-- ═══════════════════════════════════════════════════════════════════════════
-- Invoices: survive deletion of the order they bill.
--
-- invoices.order_id is `REFERENCES orders(order_id) ON DELETE SET NULL`, and
-- order deletion is a HARD delete. So when an order is destroyed the invoice
-- silently loses every trace of it: order_id goes NULL and the invoice becomes
-- indistinguishable from one that was never tied to an order at all. The
-- accountant is left holding a receivable with no way to know the work behind
-- it no longer exists — and no signal that it may need voiding.
--
-- Fix mirrors the pattern already used one column up for customers ("the CRM
-- link survives customer soft/hard deletion via the name snapshot"): keep a
-- human-readable snapshot of the order number that the FK cannot null out.
--
--   order_number_snapshot -- captured whenever an invoice is linked to an order
--   order_deleted_at      -- best-effort "when", stamped by deleteOrder()
--
-- Detection is deliberately NOT based on order_deleted_at. An invoice is
-- orphaned iff:
--
--   order_id IS NULL AND order_number_snapshot IS NOT NULL
--
-- i.e. "we once had an order, the link is now gone". That invariant is
-- maintained by the FK itself, so the marker still appears if an order is
-- removed by a path that never runs deleteOrder() (company cascade, manual
-- SQL, a future bulk tool). order_deleted_at only enriches the message.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS order_number_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS order_deleted_at       TIMESTAMPTZ;

COMMENT ON COLUMN public.invoices.order_number_snapshot IS
  'Order number captured at link time; survives the ON DELETE SET NULL of order_id so a deleted order is still identifiable.';
COMMENT ON COLUMN public.invoices.order_deleted_at IS
  'Best-effort timestamp stamped when the billed order was deleted. NULL does not mean "not deleted" — see order_id IS NULL AND order_number_snapshot IS NOT NULL.';

-- ── Backfill 1: invoices whose order still exists ──────────────────────────
-- Gives every currently-linked invoice a snapshot, so a deletion tomorrow is
-- caught even though the app code below only started writing it today.
UPDATE public.invoices i
SET    order_number_snapshot = o.order_number
FROM   public.orders o
WHERE  o.order_id = i.order_id
  AND  i.order_number_snapshot IS NULL;

-- ── Backfill 2: invoices already orphaned before this migration ────────────
-- Their order is long gone, but createInvoiceFromOrder() stamped the number
-- into the memo ("Generated from order PX-2026-00042"), so it is recoverable.
-- Only touches rows with that exact memo shape: an invoice that never had an
-- order has no such memo and is correctly left alone. order_deleted_at stays
-- NULL because the deletion time is genuinely unknown for these.
UPDATE public.invoices
SET    order_number_snapshot = substring(memo from '^Generated from order (.+)$')
WHERE  order_id IS NULL
  AND  order_number_snapshot IS NULL
  AND  memo ~ '^Generated from order .+$';

-- Partial index over exactly the orphan predicate, so "show me invoices whose
-- order is gone" stays cheap as the ledger grows.
CREATE INDEX IF NOT EXISTS idx_invoices_order_detached
  ON public.invoices (company_id, issue_date DESC)
  WHERE order_id IS NULL AND order_number_snapshot IS NOT NULL;
