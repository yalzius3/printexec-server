import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Removes stored file bytes for the order purge.
 *
 * A seam of its own rather than a Supabase client bolted onto OrdersService:
 * the purge is the only thing in the orders module that touches object storage,
 * and keeping the credentials, the bucket name and the failure policy behind one
 * method means OrdersService stays a database service.
 *
 * The client is built the same way FilePurgeService builds its own — service
 * role key, bucket from SUPABASE_UPLOAD_BUCKET — because both are deleting from
 * the same bucket and there is no reason for them to disagree about where it is.
 *
 * NOTE this is deliberately NOT gated behind PURGE_ENABLED. That flag exists to
 * stop the AUTOMATIC retention sweep from deleting files nobody asked it to
 * touch. A purge is a human pressing a button on one named order, having
 * confirmed it; a flag meant for a background job has no business vetoing that.
 */
@Injectable()
export class OrderFilesService {
  private readonly logger = new Logger("OrderFilesService");
  private readonly supabase: SupabaseClient;
  private readonly bucket: string;

  constructor(private readonly config: ConfigService) {
    this.supabase = createClient(
      this.config.getOrThrow<string>("SUPABASE_URL"),
      this.config.getOrThrow<string>("SUPABASE_SERVICE_ROLE_KEY")
    );
    this.bucket = process.env.SUPABASE_UPLOAD_BUCKET || "uploads";
  }

  /**
   * Delete objects by storage key. Best-effort by design and it must stay that
   * way: this runs AFTER the purge transaction has committed, so the order is
   * already gone and there is nothing left to roll back to. Throwing here would
   * return a 500 for an operation that actually succeeded, and the operator
   * would reasonably retry a delete on an order that no longer exists.
   *
   * So a failure is logged WITH THE KEYS. That log line is the only remaining
   * record of which bytes were orphaned, and it is what makes them recoverable
   * by hand; without it the files would be unreachable and unnameable forever.
   *
   * remove() is idempotent — keys already gone are not an error — so a partial
   * failure can be replayed safely from that log.
   */
  async removeObjects(keys: string[]): Promise<{ removed: number; failed: boolean }> {
    if (keys.length === 0) return { removed: 0, failed: false };
    try {
      const { error } = await this.supabase.storage.from(this.bucket).remove(keys);
      if (error) {
        this.logger.error(
          `order-purge: storage remove failed for ${keys.length} key(s). ` +
            `These bytes are now orphaned and must be removed by hand: ${keys.join(", ")} ` +
            `-- ${error.message}`
        );
        return { removed: 0, failed: true };
      }
      return { removed: keys.length, failed: false };
    } catch (e) {
      this.logger.error(
        `order-purge: storage remove threw for ${keys.length} key(s). ` +
          `These bytes are now orphaned and must be removed by hand: ${keys.join(", ")} ` +
          `-- ${e instanceof Error ? e.message : String(e)}`
      );
      return { removed: 0, failed: true };
    }
  }
}
