import type { PoolClient, QueryResult, QueryResultRow } from "pg";

/**
 * Minimal queryable surface shared by `pg`'s `Pool` and `PoolClient` (and the
 * thin adapter jobs.service passes). Lets the order-status recompute run on a
 * transaction client OR the pool without forcing every caller into a tx.
 */
export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<QueryResult<T>>;
}

/**
 * Shared cascade primitives used by pieces, beds, jobs and the customer
 * deletion flow. These are plain functions taking a transactional
 * `PoolClient` so any service can call them without creating a NestJS DI
 * cycle (beds → jobs, pieces → beds, etc.).
 */

/**
 * Release the spool reservations for a piece: return the reserved grams to
 * each spool's `asset_stock.reserved_grams` and drop the
 * `order_piece_spools` rows. Safe to call for a piece with no reservations.
 *
 * Must run inside a transaction (pass the open client).
 */
export async function releasePieceSpoolsTx(
  client: PoolClient,
  companyId: string,
  pieceId: string
): Promise<void> {
  const rows = await client.query<{ spool_asset_id: string; planned_grams: string }>(
    `SELECT spool_asset_id, planned_grams
       FROM order_piece_spools
      WHERE company_id = $1 AND piece_id = $2`,
    [companyId, pieceId]
  );
  for (const r of rows.rows) {
    await client.query(
      `UPDATE asset_stock
          SET reserved_grams = GREATEST(0, COALESCE(reserved_grams, 0) - $2)
        WHERE asset_id = $1`,
      [r.spool_asset_id, Number(r.planned_grams)]
    );
  }
  await client.query(
    `DELETE FROM order_piece_spools WHERE company_id = $1 AND piece_id = $2`,
    [companyId, pieceId]
  );
}

/**
 * Recompute an order's status purely from its piece content. This is the
 * SINGLE source of truth for order auto-status, shared by:
 *   - OrderPiecesService.syncOrderStatus (piece create/update/delete/duplicate),
 *   - JobsService (schedule / start / complete / fail / unassign / reprint …),
 *   - the bed-delete cascade.
 *
 * Derivation (mirrors the client's getOrderStatusOptions semantics so the
 * dropdown and the auto value never disagree). Cancelled pieces are not
 * outstanding work, so only ACTIVE (non-cancelled) pieces count:
 *   - no active pieces                         → draft
 *   - any active piece printing                → in_progress
 *   - every active piece done (no failures)    → completed
 *   - any work begun (scheduled/done/failed)   → in_progress
 *   - every active piece ready (none pending/assigned) → confirmed
 *   - otherwise (still being prepared)         → draft
 *
 * A manually `cancelled` order is sticky and is never auto-changed.
 */
export async function recomputeOrderStatusTx(
  executor: Queryable,
  companyId: string,
  orderId: string
): Promise<void> {
  const res = await executor.query<{
    total_piece_count: string;
    pending_piece_count: string;
    assigned_piece_count: string;
    scheduled_piece_count: string;
    printing_piece_count: string;
    done_piece_count: string;
    failed_piece_count: string;
    cancelled_piece_count: string;
  }>(
    `SELECT
        COUNT(*) AS total_piece_count,
        COUNT(*) FILTER (WHERE status = 'pending')   AS pending_piece_count,
        COUNT(*) FILTER (WHERE status = 'assigned')  AS assigned_piece_count,
        COUNT(*) FILTER (WHERE status = 'scheduled') AS scheduled_piece_count,
        COUNT(*) FILTER (WHERE status = 'printing')  AS printing_piece_count,
        COUNT(*) FILTER (WHERE status = 'done')      AS done_piece_count,
        COUNT(*) FILTER (WHERE status = 'failed')    AS failed_piece_count,
        COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_piece_count
       FROM order_pieces
      WHERE company_id = $1 AND order_id = $2`,
    [companyId, orderId]
  );
  const summary = res.rows[0];
  if (!summary) return;

  const currentOrder = await executor.query<{ status: string }>(
    `SELECT status
       FROM orders
      WHERE company_id = $1 AND order_id = $2`,
    [companyId, orderId]
  );

  const scheduled = Number(summary.scheduled_piece_count);
  const printing = Number(summary.printing_piece_count);
  const done = Number(summary.done_piece_count);
  const failed = Number(summary.failed_piece_count);
  const cancelled = Number(summary.cancelled_piece_count);
  const active = Number(summary.total_piece_count) - cancelled;

  if (
    currentOrder.rows[0]?.status === "confirmed" &&
    printing === 0 &&
    done === 0 &&
    failed === 0
  ) {
    return;
  }

  let target: "draft" | "confirmed" | "in_progress" | "completed";
  if (active === 0) {
    target = "draft";
  } else if (printing > 0) {
    target = "in_progress";
  } else if (failed === 0 && done === active) {
    target = "completed";
  } else if (scheduled > 0 || done > 0 || failed > 0) {
    target = "in_progress";
  } else {
    target = "draft";
  }

  await executor.query(
    `UPDATE orders SET status = $3
      WHERE company_id = $1 AND order_id = $2
        AND status != 'cancelled'
        AND status != $3`,
    [companyId, orderId, target]
  );
}

/**
 * Re-evaluate a bed after one or more of its child pieces have been removed
 * (deleted) or cancelled. Call this once, AFTER the piece status/delete has
 * been applied, with the open transaction client.
 *
 * Rules (per product spec):
 *   - No pieces remain (all were deleted)        → DELETE the bed.
 *   - All remaining pieces are 'cancelled'       → CANCEL the bed.
 *   - Otherwise (a piece was deleted/cancelled
 *     but live pieces remain)                    → DISMANTLE the bed:
 *        surviving non-terminal pieces are released to standalone 'pending';
 *        terminal pieces (cancelled/done/failed/printing) keep their status
 *        but are detached (bed_id = NULL); the bed is marked 'disassembled'.
 */
export async function reevaluateBedAfterPieceRemoval(
  client: PoolClient,
  companyId: string,
  bedId: string
): Promise<void> {
  const res = await client.query<{ status: string }>(
    `SELECT status FROM order_pieces WHERE company_id = $1 AND bed_id = $2`,
    [companyId, bedId]
  );
  const pieces = res.rows;

  // All child pieces gone → the bed has nothing left; delete it.
  if (pieces.length === 0) {
    await client.query(
      `DELETE FROM print_beds WHERE company_id = $1 AND bed_id = $2`,
      [companyId, bedId]
    );
    return;
  }

  // Every surviving piece is cancelled → cancel the bed too.
  if (pieces.every((p) => p.status === "cancelled")) {
    await client.query(
      `UPDATE print_beds
          SET status             = 'cancelled',
              scheduled_start_at = NULL,
              scheduled_end_at   = NULL,
              scheduled_at       = NULL
        WHERE company_id = $1 AND bed_id = $2`,
      [companyId, bedId]
    );
    return;
  }

  // Mixed: the bed arrangement is no longer valid — dismantle it. Live
  // pieces return to standalone 'pending'; terminal pieces keep their
  // status. Everything detaches from the bed.
  await client.query(
    `UPDATE order_pieces
        SET bed_id = NULL,
            status = CASE
              WHEN status IN ('cancelled', 'done', 'failed', 'printing') THEN status
              ELSE 'pending'
            END
      WHERE company_id = $1 AND bed_id = $2`,
    [companyId, bedId]
  );
  await client.query(
    `UPDATE print_beds
        SET status                   = 'disassembled',
            assigned_printer_id      = NULL,
            assigned_nozzle_asset_id = NULL,
            scheduled_start_at       = NULL,
            scheduled_end_at         = NULL,
            scheduled_at             = NULL
      WHERE company_id = $1 AND bed_id = $2`,
    [companyId, bedId]
  );
}

/**
 * Free everything a printer is holding that hasn't started printing yet —
 * called when a printer is toggled OFFLINE (directly, or implicitly because it
 * was put under maintenance). An offline printer is excluded from assignment,
 * so any work still committed to it can never run; it returns to the
 * unassigned 'pending' pool so the operator can re-assign it elsewhere.
 *
 * Scope:
 *   - "Below the printing stage" = status IN ('assigned','ready','scheduled').
 *     In-flight ('printing') and finished/terminal work is deliberately left
 *     untouched — yanking an active print would be destructive.
 *   - Standalone pieces lose their printer/nozzle/schedule and their filament
 *     reservation, dropping back to 'pending'.
 *   - Beds keep their grouping but lose the printer/nozzle/schedule and their
 *     reservation, dropping the bed (and its still-pending child pieces) back
 *     to 'pending' so the whole plate can be re-assigned.
 *
 * Must run inside a transaction (pass the open client). Returns how many
 * standalone pieces and beds were reverted.
 */
export async function revertPrinterAssignmentsTx(
  client: PoolClient,
  companyId: string,
  printerId: string
): Promise<{ pieces: number; beds: number }> {
  const affectedOrders = new Set<string>();

  // ── 1. Standalone pieces (not on a bed) committed to this printer ──────────
  const pieces = await client.query<{ piece_id: string; order_id: string }>(
    `SELECT piece_id, order_id
       FROM order_pieces
      WHERE company_id = $1
        AND assigned_printer_id = $2
        AND bed_id IS NULL
        AND status IN ('assigned', 'ready', 'scheduled')`,
    [companyId, printerId]
  );
  for (const p of pieces.rows) {
    await releasePieceSpoolsTx(client, companyId, p.piece_id);
    affectedOrders.add(p.order_id);
  }
  if (pieces.rowCount && pieces.rowCount > 0) {
    await client.query(
      `UPDATE order_pieces
          SET status                   = 'pending',
              assigned_printer_id      = NULL,
              assigned_nozzle_asset_id = NULL,
              scheduled_at             = NULL,
              scheduled_start_at       = NULL,
              scheduled_end_at         = NULL
        WHERE company_id = $1
          AND assigned_printer_id = $2
          AND bed_id IS NULL
          AND status IN ('assigned', 'ready', 'scheduled')`,
      [companyId, printerId]
    );
  }

  // ── 2. Beds committed to this printer (only if the beds table exists) ───────
  const bedsProbe = await client.query<{ reg: string | null }>(
    `SELECT to_regclass('public.print_beds')::text AS reg`
  );
  let bedCount = 0;
  if (bedsProbe.rows[0]?.reg) {
    const beds = await client.query<{ bed_id: string }>(
      `SELECT bed_id
         FROM print_beds
        WHERE company_id = $1
          AND assigned_printer_id = $2
          AND status IN ('assigned', 'ready', 'scheduled')`,
      [companyId, printerId]
    );
    bedCount = beds.rowCount ?? 0;

    for (const b of beds.rows) {
      // Release the bed's filament reservations (held per child piece).
      const childPieces = await client.query<{ piece_id: string; order_id: string }>(
        `SELECT piece_id, order_id FROM order_pieces WHERE company_id = $1 AND bed_id = $2`,
        [companyId, b.bed_id]
      );
      for (const cp of childPieces.rows) {
        await releasePieceSpoolsTx(client, companyId, cp.piece_id);
        affectedOrders.add(cp.order_id);
      }

      // Child pieces still below printing → 'pending' (kept on the bed). Guard
      // with a savepoint: an unmigrated bedded-piece check constraint (23514)
      // must not abort the whole transaction — skip the propagation if so.
      await client.query("SAVEPOINT revert_bed_pieces");
      try {
        await client.query(
          `UPDATE order_pieces
              SET status = 'pending'
            WHERE company_id = $1 AND bed_id = $2
              AND status IN ('assigned', 'ready', 'scheduled')`,
          [companyId, b.bed_id]
        );
        await client.query("RELEASE SAVEPOINT revert_bed_pieces");
      } catch (e) {
        if ((e as { code?: string } | null)?.code === "23514") {
          await client.query("ROLLBACK TO SAVEPOINT revert_bed_pieces");
        } else {
          throw e;
        }
      }

      // The bed itself loses its printer/nozzle/schedule but stays grouped.
      await client.query(
        `UPDATE print_beds
            SET status                   = 'pending',
                assigned_printer_id      = NULL,
                assigned_nozzle_asset_id = NULL,
                scheduled_at             = NULL,
                scheduled_start_at       = NULL,
                scheduled_end_at         = NULL
          WHERE company_id = $1 AND bed_id = $2`,
        [companyId, b.bed_id]
      );
    }
  }

  // Each touched order may have changed rollup status (e.g. confirmed → draft).
  for (const orderId of affectedOrders) {
    await recomputeOrderStatusTx(client, companyId, orderId);
  }

  return { pieces: pieces.rowCount ?? 0, beds: bedCount };
}

/**
 * Mark a printer as actively printing. `printer_stock` enforces CHECK
 * constraints that bind `is_in_use` to its companion columns, so the flag can
 * never be flipped in isolation:
 *   - chk_print_started:        is_in_use ⇔ print_started_at IS NOT NULL
 *   - chk_project_while_in_use: is_in_use ⇔ currently_printing_order_id IS NOT NULL
 *   - chk_no_use_while_offline / chk_no_concurrent_states: cannot be in_use
 *     while offline or under maintenance.
 * The offline/maintenance guard keeps the flip a safe no-op for an
 * unavailable printer instead of raising a constraint violation. Idempotent:
 * re-running keeps the original print_started_at.
 */
export async function markPrinterPrintingTx(
  executor: Queryable,
  companyId: string,
  printerId: string,
  orderId: string,
  pieceId: string | null
): Promise<void> {
  await executor.query(
    `UPDATE printer_stock
        SET is_in_use                   = TRUE,
            currently_printing_order_id = $3,
            currently_printing_piece_id = $4,
            print_started_at            = COALESCE(print_started_at, now())
      WHERE company_id = $1
        AND printer_id = $2
        AND is_offline = FALSE
        AND is_under_maintenance = FALSE`,
    [companyId, printerId, orderId, pieceId]
  );
}

/**
 * Free a printer once its piece is done/failed/cancelled. Guarded by
 * `currently_printing_piece_id` so completing a still-`scheduled` piece (whose
 * printer was never locked, or is locked by another piece) is a no-op rather
 * than stealing the flag. Clears every is_in_use companion column so the
 * `printer_stock` CHECK constraints hold for the FALSE state.
 */
export async function releasePrinterForPieceTx(
  executor: Queryable,
  companyId: string,
  printerId: string,
  pieceId: string
): Promise<void> {
  await executor.query(
    `UPDATE printer_stock
        SET is_in_use                   = FALSE,
            currently_printing_order_id = NULL,
            currently_printing_piece_id = NULL,
            print_started_at            = NULL,
            last_available_at           = now()
      WHERE company_id = $1
        AND printer_id = $2
        AND currently_printing_piece_id = $3`,
    [companyId, printerId, pieceId]
  );
}

/**
 * Free a printer by id, unconditionally. Used for bed completion where the
 * lock is held against the bed's printer (not a single piece). Clears the
 * is_in_use companion columns to satisfy the FALSE-state CHECK constraints.
 */
export async function releasePrinterTx(
  executor: Queryable,
  companyId: string,
  printerId: string
): Promise<void> {
  await executor.query(
    `UPDATE printer_stock
        SET is_in_use                   = FALSE,
            currently_printing_order_id = NULL,
            currently_printing_piece_id = NULL,
            print_started_at            = NULL,
            last_available_at           = now()
      WHERE company_id = $1
        AND printer_id = $2`,
    [companyId, printerId]
  );
}
