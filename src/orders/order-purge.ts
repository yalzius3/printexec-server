import type { PoolClient } from "pg";
import {
  releasePieceSpoolsTx,
  releasePrinterForPieceTx,
  reevaluateBedAfterPieceRemoval
} from "../common/cascade";
// storage-keys, NOT storage-files.service: this module is pure and reachable
// from `node --test`, which cannot parse the service's constructor parameter
// properties. See the header of storage-keys.ts.
import { keysFromRows, PIECE_FILE_FIELDS } from "../storage/storage-keys";

// ════════════════════════════════════════════════════════════════
// ORDER PURGE — "cancel and delete", the version that leaves nothing.
//
// DELETE /orders/:id already existed and is not this. That one removes the
// order and its pieces and deliberately keeps the paper: the invoice survives
// flagged with order_deleted_at, the history gains a "deleted" breadcrumb, the
// files stay in the bucket, and the waste events keep pointing at nothing. It
// is the right behaviour for "this order is over".
//
// This is the other thing: the order never happened. Rows, files, and the
// financial record all go, and afterwards there is no way to tell from the
// database that the order ever existed.
//
// ── WHAT SURVIVES ON PURPOSE, AND WHY ───────────────────────────────────────
// Two things, and destroying either would be worse than keeping it:
//
//   · PAYMENTS. A payment is a document in its own right: it can settle several
//     invoices at once, it can carry an unapplied remainder, and its journal
//     entry records cash that really did arrive in a real account. Deleting it
//     because one of the invoices it touched is going away would make the bank
//     balance wrong — a far worse lie than an unapplied receipt. So the
//     APPLICATION (the link to this order's invoice) is removed and the payment
//     itself is left, becoming an unapplied credit for that customer. The
//     result reports how many, and for how much, so it is never silent.
//
//   · THE ORDER NUMBER. order_number_sequences is not rewound. Giving the next
//     order a number a deleted one already used is how two documents end up
//     sharing a reference; a gap in the sequence costs nothing and is invisible
//     to everyone except an auditor counting.
//
// ── WHAT THIS COSTS, STATED PLAINLY ─────────────────────────────────────────
// Erasing an ISSUED invoice erases revenue and a receivable that were really
// recorded. The trial balance still balances afterwards — a journal entry
// balances on its own, so removing one entirely leaves the rest square — but
// the period's totals change. That is what "as if it never happened" means once
// an order has reached the books, and it is why this must always be an
// explicit, confirmed human action and never a cascade from anything else.
//
// ── ORDERING IS THE WHOLE ALGORITHM ─────────────────────────────────────────
// Children before parents, and every id captured BEFORE the row carrying it
// disappears. Several of these FKs are ON DELETE SET NULL (invoices.order_id,
// filament_waste_events.order_id) precisely so that a delete does NOT cascade —
// get the order wrong and the row survives, unfindable, with a null link. So
// nothing here leans on FK behaviour: every child is deleted explicitly, which
// is also why it does not matter that the base schema's ON DELETE rules are not
// all declared in this repo.
// ════════════════════════════════════════════════════════════════

/** Everything one purge destroyed. Returned so the caller can report it. */
export interface OrderPurgeResult {
  order_number: string;
  pieces: number;
  beds_settled: number;
  attachments: number;
  /** Storage object keys to remove AFTER the transaction commits. */
  storage_keys: string[];
  invoices: number;
  invoice_numbers: string[];
  journal_entries: number;
  waste_events: number;
  history_rows: number;
  /** Payments left standing, now unapplied. The operator needs to know. */
  payment_applications_removed: number;
  payments_left_unapplied: number;
  unapplied_amount: string;
}

// storageKeyFromUrl used to be redefined here, byte-identical to the copy in
// FilePurgeService, because importing that service would have dragged its
// Supabase client into this module for four lines of string work. Both copies
// now re-export the one in storage-files.service.ts, which is a plain function
// with no DI — so the reason for duplicating it is gone, and with it the risk
// of the two parsers drifting apart.
export { storageKeyFromUrl } from "../storage/storage-keys";

/**
 * Erase one order and everything that exists only because of it.
 *
 * MUST run inside a transaction — it sets a transaction-local GUC that unlocks
 * deletion of posted journal entries (see migrations/2026-08-25_order_purge.sql)
 * and that unlock is only safe because COMMIT/ROLLBACK ends it.
 *
 * Storage bytes are NOT removed here: a bucket delete cannot be rolled back, so
 * doing it inside the transaction would destroy files for an order that a later
 * failure leaves standing. The keys come back in the result and the caller
 * removes them once the transaction has committed.
 */
export async function purgeOrderTx(
  client: PoolClient,
  companyId: string,
  orderId: string,
  order: { order_number: string; title: string; customer_id: string | null }
): Promise<OrderPurgeResult> {
  // Unlock posted-ledger deletion for THIS TRANSACTION ONLY. SET LOCAL is undone
  // by COMMIT and by ROLLBACK, and binds to this client's transaction, so it can
  // neither outlive the purge nor leak to another pooled connection.
  await client.query("SET LOCAL printexec.purge_order = 'on'");

  // ── 1. Pieces: snapshot before anything is released or deleted ────────────
  // `op.*` rather than a named list. Two reasons: the file columns each ship in
  // their own migration (naming stl_thumbnail_url on a database that has not
  // run 2026-07-04_piece_stl_thumbnail.sql raises 42703 and 500s the purge),
  // and a star cannot silently omit a NEW file column the way the old named
  // list omitted the thumbnail — which is how "cancel and delete", the path
  // whose whole promise is that nothing remains, was still leaving every
  // piece's thumbnail PNG in the bucket.
  const pieces = await client.query<{
    piece_id: string;
    bed_id: string | null;
    status: string;
    assigned_printer_id: string | null;
    slicer_file_url?: string | null;
    stl_file_url?: string | null;
    stl_thumbnail_url?: string | null;
  }>(
    `SELECT op.*
       FROM order_pieces op
      WHERE op.order_id = $1 AND op.company_id = $2`,
    [orderId, companyId]
  );

  // Free any printer a piece is actively holding BEFORE its row goes. Otherwise
  // printer_stock keeps is_in_use = TRUE with a dangling
  // currently_printing_piece_id, which both strands the machine and can trip the
  // is_in_use CHECK constraints as the FK nulls out — a 500 on the delete
  // itself. releasePrinterForPieceTx is a no-op unless this piece holds the
  // lock, so calling it per printing piece is safe.
  for (const p of pieces.rows) {
    if (p.status === "printing" && p.assigned_printer_id) {
      await releasePrinterForPieceTx(client, companyId, p.assigned_printer_id, p.piece_id);
    }
  }

  // Hand reserved filament back to stock. Note DELETE /orders/:id does a raw
  // DELETE FROM order_piece_spools instead, which drops the allocation rows
  // without decrementing asset_stock.reserved_grams — so every order deleted
  // that way leaks its reservation. Going through the shared helper (the one the
  // bed-delete path already uses) is what keeps stock honest here.
  for (const p of pieces.rows) {
    await releasePieceSpoolsTx(client, companyId, p.piece_id);
  }

  // ── 2. Files: collect keys now, remove the bytes after commit ─────────────
  const attachments = await client.query<{ file_url: string | null }>(
    `SELECT file_url FROM order_attachments WHERE company_id = $1 AND order_id = $2`,
    [companyId, orderId]
  );
  // One file can legitimately be referenced twice (a piece duplicated from
  // another keeps the same slicer URL) — keysFromRows returns a set, and the
  // caller passes the result through removeUnreferenced, which is what makes
  // it safe even when the twin lives outside this order.
  const uniqueKeys = [
    ...new Set([
      ...keysFromRows(pieces.rows, PIECE_FILE_FIELDS),
      ...keysFromRows(attachments.rows, ["file_url"])
    ])
  ];

  // ── 3. The financial record ───────────────────────────────────────────────
  // Invoices first: their journal entries have to be captured before the order
  // row goes, because invoices.order_id is ON DELETE SET NULL and the link
  // would simply vanish.
  const invoices = await client.query<{
    invoice_id: string;
    invoice_number: string;
    journal_entry_id: string | null;
  }>(
    `SELECT invoice_id, invoice_number, journal_entry_id
       FROM invoices WHERE company_id = $1 AND order_id = $2`,
    [companyId, orderId]
  );
  const invoiceIds = invoices.rows.map((r) => r.invoice_id);

  // Waste events carry their own entry (abnormal spoilage), and their order_id
  // is ON DELETE SET NULL too — they would otherwise outlive the order as an
  // orphaned loss record, which is exactly the trace being removed.
  const waste = await client.query<{ waste_id: string; journal_entry_id: string | null }>(
    `SELECT waste_id, journal_entry_id
       FROM filament_waste_events WHERE company_id = $1 AND order_id = $2`,
    [companyId, orderId]
  );

  // Detach payments from these invoices, and measure what that leaves behind.
  // The application rows go; the payments do not (see the header).
  let applicationsRemoved = 0;
  let paymentsLeft = 0;
  let unappliedAmount = "0.00";
  if (invoiceIds.length > 0) {
    const apps = await client.query<{ payments: string; applications: string; total: string }>(
      `SELECT COUNT(DISTINCT payment_id)::text AS payments,
              COUNT(*)::text                   AS applications,
              COALESCE(SUM(amount), 0)::text   AS total
         FROM payment_applications
        WHERE company_id = $1 AND invoice_id = ANY($2::uuid[])`,
      [companyId, invoiceIds]
    );
    const row = apps.rows[0];
    applicationsRemoved = Number(row?.applications ?? 0);
    paymentsLeft = Number(row?.payments ?? 0);
    unappliedAmount = row?.total ?? "0.00";

    // payment_applications.invoice_id has no ON DELETE action — it is a plain
    // DEFERRABLE FK — so leaving these would fail the invoice delete at COMMIT
    // rather than at the statement, which is a confusing place to find out.
    await client.query(
      `DELETE FROM payment_applications WHERE company_id = $1 AND invoice_id = ANY($2::uuid[])`,
      [companyId, invoiceIds]
    );
    // invoice_lines and invoice_emails are ON DELETE CASCADE from invoices.
    await client.query(
      `DELETE FROM invoices WHERE company_id = $1 AND invoice_id = ANY($2::uuid[])`,
      [companyId, invoiceIds]
    );
  }

  await client.query(
    `DELETE FROM filament_waste_events WHERE company_id = $1 AND order_id = $2`,
    [companyId, orderId]
  );

  // Journal entries last of the finance rows: invoices.journal_entry_id and
  // filament_waste_events.journal_entry_id both point AT them, so those pointers
  // have to be gone first or the deletes collide with those FKs.
  //
  // A reversal entry references what it reverses (reverses_entry_id, DEFERRABLE
  // INITIALLY DEFERRED). Deleting a reversed entry while its reversal stands
  // leaves a dangling reference that fails at COMMIT, so reversals are pulled in
  // and deleted alongside — destroying a document means destroying the
  // correction that only ever existed to cancel it.
  const entryIds = [
    ...invoices.rows.map((r) => r.journal_entry_id),
    ...waste.rows.map((r) => r.journal_entry_id)
  ].filter((id): id is string => !!id);
  let entriesDeleted = 0;
  if (entryIds.length > 0) {
    const withReversals = await client.query<{ entry_id: string }>(
      `SELECT entry_id FROM journal_entries
        WHERE company_id = $1
          AND (entry_id = ANY($2::uuid[]) OR reverses_entry_id = ANY($2::uuid[]))`,
      [companyId, entryIds]
    );
    const allEntryIds = withReversals.rows.map((r) => r.entry_id);
    if (allEntryIds.length > 0) {
      await client.query(
        `DELETE FROM journal_lines WHERE company_id = $1 AND entry_id = ANY($2::uuid[])`,
        [companyId, allEntryIds]
      );
      const del = await client.query(
        `DELETE FROM journal_entries WHERE company_id = $1 AND entry_id = ANY($2::uuid[])`,
        [companyId, allEntryIds]
      );
      entriesDeleted = del.rowCount ?? 0;
    }
  }

  // ── 4. The order's own rows ───────────────────────────────────────────────
  await client.query(
    `DELETE FROM order_attachments WHERE company_id = $1 AND order_id = $2`,
    [companyId, orderId]
  );
  // Colour slots hang off the piece. Explicit rather than trusting a cascade,
  // for the reason in the header.
  await client.query(
    `DELETE FROM order_piece_color_slots
      WHERE piece_id IN (SELECT piece_id FROM order_pieces WHERE order_id = $1 AND company_id = $2)`,
    [orderId, companyId]
  );
  await client.query(
    `DELETE FROM order_pieces WHERE order_id = $1 AND company_id = $2`,
    [orderId, companyId]
  );

  // A bed may hold pieces from several orders: all of its pieces gone → the bed
  // goes with them; some kept → it is disassembled. Once per bed.
  const affectedBedIds = [
    ...new Set(pieces.rows.map((p) => p.bed_id).filter((b): b is string => !!b))
  ];
  for (const bedId of affectedBedIds) {
    // A bed emptied by this purge is deleted, and its own plate G-code/STL —
    // separate objects from any piece's — come back here to be removed with
    // everything else. Nothing removed them before.
    uniqueKeys.push(...(await reevaluateBedAfterPieceRemoval(client, companyId, bedId)));
  }

  // order_emails is ON DELETE CASCADE from orders, but the whole point of this
  // module is not depending on that.
  await client.query(
    `DELETE FROM order_emails WHERE company_id = $1 AND order_id = $2`,
    [companyId, orderId]
  );

  // Every breadcrumb the order ever dropped, including ones written by the piece
  // flows and the file-purge sweep. Matched on order_id AND on the number,
  // because rows written by a delete path carry the number with a null order_id.
  const history = await client.query(
    `DELETE FROM order_history
      WHERE company_id = $1
        AND (order_id = $2 OR (order_id IS NULL AND order_number = $3))`,
    [companyId, orderId, order.order_number]
  );

  // The CRM timeline entry createOrder writes. Matched on the exact string that
  // code produces rather than a LIKE, so a note merely mentioning the number is
  // never caught by it.
  if (order.customer_id) {
    await client.query(
      `DELETE FROM customer_interactions
        WHERE company_id = $1 AND customer_id = $2
          AND interaction_type = 'ADDITION'
          AND description = $3`,
      [companyId, order.customer_id, `Placed new order #${order.order_number}: ${order.title}`]
    );
  }

  await client.query(
    `DELETE FROM orders WHERE order_id = $1 AND company_id = $2`,
    [orderId, companyId]
  );

  // The customer's order count has to forget it too, or the CRM still says the
  // work happened.
  if (order.customer_id) {
    await client.query(
      `UPDATE customers
          SET total_orders = GREATEST(0, total_orders - 1)
        WHERE customer_id = $1 AND company_id = $2`,
      [order.customer_id, companyId]
    );
  }

  // Deliberately NO order_history row for the purge itself. Every other delete
  // path writes one; this one cannot, because a breadcrumb reading "order #X was
  // erased" is precisely the evidence the operator asked to be rid of.

  return {
    order_number: order.order_number,
    pieces: pieces.rows.length,
    beds_settled: affectedBedIds.length,
    attachments: attachments.rows.length,
    // De-duped again: the bed sweep above appended after the first pass.
    storage_keys: [...new Set(uniqueKeys)],
    invoices: invoices.rows.length,
    invoice_numbers: invoices.rows.map((r) => r.invoice_number),
    journal_entries: entriesDeleted,
    waste_events: waste.rows.length,
    history_rows: history.rowCount ?? 0,
    payment_applications_removed: applicationsRemoved,
    payments_left_unapplied: paymentsLeft,
    unapplied_amount: unappliedAmount
  };
}
