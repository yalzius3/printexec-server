import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import {
  recomputeOrderStatusTx,
  markPrinterPrintingTx,
  releasePrinterForPieceTx,
  releasePrinterTx
} from "../common/cascade";

type Client = import("pg").PoolClient;

// ════════════════════════════════════════════════════════════════
// TIME-AWARE STATE ADVANCEMENT
//
// The lifecycle is mutated by explicit operator actions everywhere else, but
// two transitions are driven purely by the clock and had no other owner:
//
//   scheduled → printing   when scheduled_start_at arrives.
//   printing  → done        when scheduled_end_at   passes.
//
// This service is the single, global owner of those time transitions: it
// mutates the DB so every page/component that reads order_pieces / print_beds
// observes the same state — no per-component derivation. The auto-complete on
// scheduled_end_at mirrors the manual complete({outcome:'done'}) path exactly:
// it consumes the reserved filament (deducts it from the spool), stamps the
// completion, logs the lifecycle event, and (for beds) propagates 'done' to the
// constituent pieces. An operator can still override the recorded outcome (e.g.
// mark a run 'failed' and reprint) — auto-complete only fills the gap when the
// window ends with no human decision.
// ════════════════════════════════════════════════════════════════
@Injectable()
export class TimeStateService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("TimeStateService");
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly db: DatabaseService) {}

  onModuleInit(): void {
    // First sweep shortly after boot, then every minute.
    setTimeout(() => void this.tick(), 5_000);
    this.timer = setInterval(() => void this.tick(), 60_000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One sweep. Re-entrancy-guarded so a slow tick can't overlap itself. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Start before finish so a print whose whole window is already in the
      // past lands directly on 'done' within a single sweep.
      const startedPieces = await this.advancePieces();
      const startedBeds = await this.advanceBeds();
      const donePieces = await this.completeDuePieces();
      const doneBeds = await this.completeDueBeds();
      if (startedPieces + startedBeds > 0) {
        this.logger.log(`time-state: ${startedPieces} piece(s) + ${startedBeds} bed(s) scheduled→printing`);
      }
      if (donePieces + doneBeds > 0) {
        this.logger.log(`time-state: ${donePieces} piece(s) + ${doneBeds} bed(s) printing→done`);
      }
    } catch (e) {
      this.logger.warn(`time-state tick failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  // ──────────────────────────────────────────────────────────
  // scheduled → printing
  // ──────────────────────────────────────────────────────────

  /** Standalone pieces (not bedded — bedded pieces follow their bed below). */
  private async advancePieces(): Promise<number> {
    return this.db.transaction(async (c: Client) => {
      const res = await c.query<{
        piece_id: string; order_id: string; company_id: string;
        assigned_printer_id: string | null;
      }>(
        `UPDATE order_pieces
            SET status = 'printing',
                print_started_at = COALESCE(print_started_at, scheduled_start_at, now())
          WHERE status = 'scheduled'
            AND bed_id IS NULL
            AND scheduled_start_at IS NOT NULL
            AND scheduled_start_at <= now()
          RETURNING piece_id, order_id, company_id, assigned_printer_id`
      );
      // Lock each piece's assigned printer in the same transaction as the flip.
      for (const r of res.rows) {
        if (r.assigned_printer_id) {
          await markPrinterPrintingTx(c, r.company_id, r.assigned_printer_id, r.order_id, r.piece_id);
        }
      }
      return res.rowCount ?? 0;
    });
  }

  /** Beds, then propagate the printing status to their constituent pieces. */
  private async advanceBeds(): Promise<number> {
    const beds = await this.db.query<{
      bed_id: string; company_id: string; assigned_printer_id: string | null;
    }>(
      `UPDATE print_beds
          SET status = 'printing',
              print_started_at = COALESCE(print_started_at, scheduled_start_at, now())
        WHERE status = 'scheduled'
          AND scheduled_start_at IS NOT NULL
          AND scheduled_start_at <= now()
        RETURNING bed_id, company_id, assigned_printer_id`
    );
    for (const b of beds.rows) {
      try {
        await this.db.query(
          `UPDATE order_pieces
              SET status = 'printing',
                  print_started_at = COALESCE(print_started_at, now())
            WHERE company_id = $1 AND bed_id = $2 AND status = 'scheduled'`,
          [b.company_id, b.bed_id]
        );
      } catch (e) {
        // Swallow the bedded-piece check-constraint violation if the exemption
        // migration hasn't run yet (mirrors propagatePieceStatus).
        if ((e as { code?: string } | null)?.code !== "23514") throw e;
      }
      // Lock the bed's printer. printer_stock requires a non-null
      // currently_printing_order_id while in_use, so borrow one child piece's
      // order (a bed can span orders; the flag only records a representative).
      if (b.assigned_printer_id) {
        const childOrder = (
          await this.db.query<{ order_id: string }>(
            `SELECT order_id FROM order_pieces
              WHERE company_id = $1 AND bed_id = $2 LIMIT 1`,
            [b.company_id, b.bed_id]
          )
        ).rows[0];
        if (childOrder) {
          await markPrinterPrintingTx(
            this.db, b.company_id, b.assigned_printer_id, childOrder.order_id, null
          );
        }
      }
    }
    return beds.rowCount ?? 0;
  }

  // ──────────────────────────────────────────────────────────
  // printing → done  (auto-complete on scheduled_end_at)
  // ──────────────────────────────────────────────────────────

  /** Deduct a piece's reserved filament from its spool(s) — same math as the
   *  services' consumeSpoolsTx. reserved_grams is also dropped by the DB trigger
   *  when status flips to 'done'; the manual decrement here floors at 0, so the
   *  two never compound into a negative. */
  private async consumeSpoolsForPieces(client: Client, companyId: string, pieceIds: string[]): Promise<void> {
    if (pieceIds.length === 0) return;
    const rows = await client.query<{ spool_asset_id: string; planned_grams: string }>(
      `SELECT spool_asset_id, planned_grams FROM order_piece_spools
        WHERE company_id = $1 AND piece_id = ANY($2::uuid[])`,
      [companyId, pieceIds]
    );
    for (const r of rows.rows) {
      const g = Number(r.planned_grams);
      await client.query(
        `UPDATE asset_stock
            SET reserved_grams  = GREATEST(0, COALESCE(reserved_grams, 0) - $2),
                remaining_grams = GREATEST(0, COALESCE(remaining_grams, 0) - $2),
                status = CASE WHEN GREATEST(0, COALESCE(remaining_grams,0) - $2) <= 0 THEN 'empty' ELSE status END
          WHERE asset_id = $1`,
        [r.spool_asset_id, g]
      );
    }
  }

  /** Standalone pieces whose scheduled window has fully elapsed. */
  private async completeDuePieces(): Promise<number> {
    const due = await this.db.query<{
      piece_id: string; company_id: string; order_id: string;
      order_number: string; piece_name: string; assigned_printer_id: string | null;
    }>(
      `SELECT op.piece_id, op.company_id, op.order_id, o.order_number, op.piece_name,
              op.assigned_printer_id
         FROM order_pieces op
         JOIN orders o ON o.order_id = op.order_id AND o.company_id = op.company_id
        WHERE op.status = 'printing'
          AND op.bed_id IS NULL
          AND op.scheduled_end_at IS NOT NULL
          AND op.scheduled_end_at <= now()`
    );
    for (const p of due.rows) {
      await this.db.transaction(async (c: Client) => {
        await c.query(
          `UPDATE order_pieces
              SET status                    = 'done',
                  print_completed_at        = now(),
                  print_started_at          = COALESCE(print_started_at, scheduled_start_at, now()),
                  actual_print_time_minutes = COALESCE(actual_print_time_minutes, slicer_print_time_minutes)
            WHERE company_id = $1 AND piece_id = $2`,
          [p.company_id, p.piece_id]
        );
        await this.consumeSpoolsForPieces(c, p.company_id, [p.piece_id]);
        // Free the printer this piece was holding (live counterpart of
        // releaseExecutionResources), in the same transaction as the flip.
        if (p.assigned_printer_id) {
          await releasePrinterForPieceTx(c, p.company_id, p.assigned_printer_id, p.piece_id);
        }
        // Consolidate the parent order in the SAME transaction as the piece
        // flip, so a clock-driven completion never leaves orders.status stale.
        await recomputeOrderStatusTx(c, p.company_id, p.order_id);
      });
      // Best-effort history — kept OUTSIDE the transaction so a missing/failed
      // log never rolls back the completion (mirrors recordPieceEvent).
      await this.logPieceEvent(
        p.company_id, p.order_id, p.order_number, p.piece_id, p.piece_name,
        `Piece "${p.piece_name}" auto-completed when its scheduled print window ended.`
      );
    }
    return due.rowCount ?? 0;
  }

  /** Beds whose scheduled window has fully elapsed: settle filament, then push
   *  'done' to the constituent pieces. */
  private async completeDueBeds(): Promise<number> {
    const due = await this.db.query<{
      bed_id: string; company_id: string; assigned_printer_id: string | null;
    }>(
      `SELECT bed_id, company_id, assigned_printer_id FROM print_beds
        WHERE status = 'printing'
          AND scheduled_end_at IS NOT NULL
          AND scheduled_end_at <= now()`
    );
    for (const b of due.rows) {
      // Distinct parent orders of this bed's child pieces — a bed can hold
      // pieces from more than one order, so each must be consolidated.
      let affectedOrderIds: string[] = [];
      await this.db.transaction(async (c: Client) => {
        await c.query(
          `UPDATE print_beds
              SET status                    = 'done',
                  print_completed_at        = now(),
                  print_started_at          = COALESCE(print_started_at, scheduled_start_at, now()),
                  actual_print_time_minutes = COALESCE(
                    actual_print_time_minutes,
                    ROUND(EXTRACT(EPOCH FROM (now() - COALESCE(print_started_at, scheduled_start_at))) / 60)::int
                  )
            WHERE company_id = $1 AND bed_id = $2`,
          [b.company_id, b.bed_id]
        );
        const childRows = (
          await c.query<{ piece_id: string; order_id: string }>(
            `SELECT piece_id, order_id FROM order_pieces WHERE company_id = $1 AND bed_id = $2`,
            [b.company_id, b.bed_id]
          )
        ).rows;
        const childIds = childRows.map((r) => r.piece_id);
        affectedOrderIds = [...new Set(childRows.map((r) => r.order_id))];
        await this.consumeSpoolsForPieces(c, b.company_id, childIds);
        // A consumed bed's piece allocations are settled — drop the ledger rows
        // (mirrors BedsService.consumeSpoolsTx).
        if (childIds.length > 0) {
          await c.query(
            `DELETE FROM order_piece_spools WHERE company_id = $1 AND piece_id = ANY($2::uuid[])`,
            [b.company_id, childIds]
          );
        }
        // Free the bed's printer in the same transaction as the settlement.
        if (b.assigned_printer_id) {
          await releasePrinterTx(c, b.company_id, b.assigned_printer_id);
        }
      });
      // Propagate to child pieces as a separate statement (not inside the
      // consume transaction): the bedded-piece check constraint can raise 23514
      // before its exemption migration runs, and we swallow only that — a poison
      // inside the transaction above would abort the whole settlement.
      try {
        await this.db.query(
          `UPDATE order_pieces
              SET status = 'done', print_completed_at = COALESCE(print_completed_at, now())
            WHERE company_id = $1 AND bed_id = $2`,
          [b.company_id, b.bed_id]
        );
      } catch (e) {
        if ((e as { code?: string } | null)?.code !== "23514") throw e;
      }
      // Consolidate each parent order now that its children read 'done'. Runs
      // after the child flip above so the recompute sees the settled statuses.
      for (const orderId of affectedOrderIds) {
        await this.db.transaction((c: Client) => recomputeOrderStatusTx(c, b.company_id, orderId));
      }
    }
    return due.rowCount ?? 0;
  }

  /** Best-effort lifecycle log into the shared order_history feed. */
  private async logPieceEvent(
    companyId: string, orderId: string, orderNumber: string,
    pieceId: string, pieceName: string, description: string
  ): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO order_history
           (company_id, entity_type, event_type, order_id, order_number, piece_id, piece_name, description)
         VALUES ($1, 'piece', 'completed', $2, $3, $4, $5, $6)`,
        [companyId, orderId, orderNumber, pieceId, pieceName, description]
      );
    } catch { /* ignore — history is non-critical */ }
  }
}
