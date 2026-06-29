import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { DatabaseService } from "../database/database.service";

type Client = import("pg").PoolClient;

// ════════════════════════════════════════════════════════════════
// FULFILLED-ORDER FILE RETENTION
//
// Heavy print inputs — G-code (order_pieces.slicer_file_url) and STL models
// (order_pieces.stl_file_url + order_attachments kind='stl') — are only needed
// up to fulfilment. Once an order has been continuously in the 'fulfilled'
// state for the retention window, those files are purged to reclaim Supabase
// Storage: the bytes are deleted from the bucket, the piece URL columns are
// nulled, and the order-level STL attachment rows are removed. PDFs, images and
// every other attachment kind are left untouched.
//
// The anchor is orders.fulfilled_at, maintained by a DB trigger (see
// migrations/2026-06-28_order_fulfilled_at.sql) so it survives the status
// rollup flipping an order back out of fulfilled — which resets the timer.
//
// SAFETY: deletion is gated behind PURGE_ENABLED. Until that flag is "true" the
// sweep runs in DRY-RUN mode: it logs exactly what it WOULD delete (file count
// + reclaimable bytes) and changes nothing. Mirrors the self-scheduling
// setInterval pattern of TimeStateService (no @nestjs/schedule dependency).
//
// Tunables (env):
//   PURGE_ENABLED            "true" to actually delete; anything else = dry-run
//   PURGE_FULFILLED_DAYS     retention window in days (default 25)
//   PURGE_SWEEP_INTERVAL_MS  sweep cadence (default 6h)
//   SUPABASE_UPLOAD_BUCKET   storage bucket (default "uploads")
// ════════════════════════════════════════════════════════════════
@Injectable()
export class FilePurgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("FilePurgeService");
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  private readonly supabase: SupabaseClient;
  private readonly bucket: string;
  private readonly retentionDays: number;
  private readonly enabled: boolean;
  private readonly sweepIntervalMs: number;

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService
  ) {
    this.supabase = createClient(
      this.config.getOrThrow<string>("SUPABASE_URL"),
      this.config.getOrThrow<string>("SUPABASE_SERVICE_ROLE_KEY")
    );
    this.bucket = process.env.SUPABASE_UPLOAD_BUCKET || "uploads";
    this.retentionDays = this.readPositiveInt(process.env.PURGE_FULFILLED_DAYS, 25);
    this.enabled = (process.env.PURGE_ENABLED ?? "").toLowerCase() === "true";
    // 25-day granularity does not need a tight loop; sweep a few times a day.
    this.sweepIntervalMs = this.readPositiveInt(
      process.env.PURGE_SWEEP_INTERVAL_MS,
      6 * 60 * 60 * 1000
    );
  }

  onModuleInit(): void {
    // First sweep shortly after boot, then on the configured cadence.
    setTimeout(() => void this.tick(), 30_000);
    this.timer = setInterval(() => void this.tick(), this.sweepIntervalMs);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One sweep. Re-entrancy-guarded so a slow sweep can't overlap itself. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const orders = await this.findEligibleOrders();
      if (orders.length === 0) return;

      let totalFiles = 0;
      let totalBytes = 0;
      let purgedOrders = 0;

      for (const order of orders) {
        const result = await this.purgeOrder(order.company_id, order.order_id);
        totalFiles += result.fileCount;
        totalBytes += result.byteCount;
        if (result.fileCount > 0) purgedOrders += 1;
      }

      if (totalFiles > 0) {
        const gb = (totalBytes / 1024 ** 3).toFixed(3);
        const verb = this.enabled ? "purged" : "DRY-RUN would purge";
        this.logger.log(
          `file-purge: ${verb} ${totalFiles} file(s) (~${gb} GB tracked) across ` +
            `${purgedOrders} fulfilled order(s) older than ${this.retentionDays}d`
        );
      }
    } catch (e) {
      this.logger.warn(`file-purge tick failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Orders that have been continuously fulfilled past the retention window AND
   * still hold at least one purgeable file. The EXISTS guards keep the sweep
   * self-limiting: once an order's G-code/STL are gone it drops out of the
   * result, so the historical backlog of fulfilled orders isn't re-scanned
   * forever.
   */
  private async findEligibleOrders(): Promise<Array<{ company_id: string; order_id: string }>> {
    const res = await this.db.query<{ company_id: string; order_id: string }>(
      `SELECT o.company_id, o.order_id
         FROM orders o
        WHERE o.status = 'fulfilled'
          AND o.fulfilled_at IS NOT NULL
          AND o.fulfilled_at <= now() - ($1 || ' days')::interval
          AND (
            EXISTS (
              SELECT 1 FROM order_pieces p
               WHERE p.company_id = o.company_id AND p.order_id = o.order_id
                 AND (p.slicer_file_url IS NOT NULL OR p.stl_file_url IS NOT NULL)
            )
            OR EXISTS (
              SELECT 1 FROM order_attachments a
               WHERE a.company_id = o.company_id AND a.order_id = o.order_id
                 AND a.kind = 'stl'
            )
          )`,
      [String(this.retentionDays)]
    );
    return res.rows;
  }

  /**
   * Collect, (optionally) delete, and unlink the purgeable G-code + STL files
   * for one order. In dry-run mode it only tallies. Returns file/byte totals so
   * the sweep can report aggregate reclaimable space.
   */
  private async purgeOrder(
    companyId: string,
    orderId: string
  ): Promise<{ fileCount: number; byteCount: number }> {
    // 1. Gather candidates: piece G-code, piece STL, order-level STL
    //    attachments. size_bytes is only tracked for attachments; piece files
    //    don't record it, so the reported GB is a lower bound (the keys still
    //    get deleted regardless).
    const pieceFiles = await this.db.query<{ url: string; size_bytes: string | null }>(
      `SELECT slicer_file_url AS url, NULL::bigint AS size_bytes
         FROM order_pieces
        WHERE company_id = $1 AND order_id = $2 AND slicer_file_url IS NOT NULL
       UNION ALL
       SELECT stl_file_url AS url, NULL::bigint AS size_bytes
         FROM order_pieces
        WHERE company_id = $1 AND order_id = $2 AND stl_file_url IS NOT NULL`,
      [companyId, orderId]
    );
    const attachmentFiles = await this.db.query<{ url: string; size_bytes: string | null }>(
      `SELECT file_url AS url, size_bytes
         FROM order_attachments
        WHERE company_id = $1 AND order_id = $2 AND kind = 'stl'`,
      [companyId, orderId]
    );

    const all = [...pieceFiles.rows, ...attachmentFiles.rows];
    const keys = all
      .map((r) => this.storageKeyFromUrl(r.url))
      .filter((k): k is string => k !== null);
    const byteCount = all.reduce(
      (sum, r) => sum + (r.size_bytes ? Number(r.size_bytes) : 0),
      0
    );
    const fileCount = keys.length;

    if (fileCount === 0) return { fileCount: 0, byteCount: 0 };

    // Dry-run: report what would happen, change nothing.
    if (!this.enabled) return { fileCount, byteCount };

    // 2. Delete the bytes from Storage. remove() is idempotent — keys already
    //    gone are not an error — so a partial prior run self-heals next sweep.
    const { error } = await this.supabase.storage.from(this.bucket).remove(keys);
    if (error) {
      // Leave DB pointers intact so the order stays eligible and we retry next
      // sweep, rather than orphaning a reference to a file we failed to delete.
      this.logger.warn(
        `file-purge: storage remove failed for order ${orderId} ` +
          `(${keys.length} key(s)): ${error.message}`
      );
      return { fileCount: 0, byteCount: 0 };
    }

    // 3. Unlink the DB references in one transaction: null the piece columns,
    //    drop the order-level STL attachment rows.
    await this.db.transaction(async (c: Client) => {
      await c.query(
        `UPDATE order_pieces
            SET slicer_file_url = NULL, slicer_file_uploaded_at = NULL
          WHERE company_id = $1 AND order_id = $2 AND slicer_file_url IS NOT NULL`,
        [companyId, orderId]
      );
      await c.query(
        `UPDATE order_pieces
            SET stl_file_url = NULL, stl_file_uploaded_at = NULL
          WHERE company_id = $1 AND order_id = $2 AND stl_file_url IS NOT NULL`,
        [companyId, orderId]
      );
      await c.query(
        `DELETE FROM order_attachments
          WHERE company_id = $1 AND order_id = $2 AND kind = 'stl'`,
        [companyId, orderId]
      );
    });

    // 4. Best-effort history breadcrumb (never roll back the purge over a log).
    await this.logPurge(companyId, orderId, fileCount);

    return { fileCount, byteCount };
  }

  /**
   * Map a stored file URL to its Supabase Storage object key. URLs are written
   * as "/api/uploads/<companyId>/<filename>" (legacy "/uploads/...") and the
   * object key mirrors the trailing "<companyId>/<filename>".
   */
  private storageKeyFromUrl(url: string | null): string | null {
    if (!url) return null;
    const marker = "/uploads/";
    const idx = url.indexOf(marker);
    if (idx < 0) return null;
    const key = url.slice(idx + marker.length).split("?")[0] ?? "";
    return key.length > 0 ? key : null;
  }

  /** Drop an order_history row recording the purge (populates order_number). */
  private async logPurge(companyId: string, orderId: string, fileCount: number): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO order_history
           (company_id, entity_type, event_type, order_id, order_number, description)
         SELECT $1, 'order', 'files_purged', order_id, order_number, $3
           FROM orders
          WHERE company_id = $1 AND order_id = $2`,
        [
          companyId,
          orderId,
          `Retention purge: removed ${fileCount} G-code/STL file(s) ` +
            `${this.retentionDays}+ days after fulfilment.`
        ]
      );
    } catch {
      /* history is non-critical */
    }
  }

  private readPositiveInt(raw: string | undefined, fallback: number): number {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  }
}
