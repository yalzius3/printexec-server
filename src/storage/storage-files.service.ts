import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { DatabaseService } from "../database/database.service";

// ════════════════════════════════════════════════════════════════
// STORAGE FILES — the one place that removes bytes from the bucket.
//
// Before this existed the bucket was write-only: five client upload sites, and
// exactly two callers that ever deleted anything (the retention sweep and the
// order purge). Every ordinary delete — an order, a piece, a bulk selection, an
// attachment, a bed, a whole tenant — left its bytes behind forever, and the
// rows naming those bytes went with the delete, so the objects became
// unreachable AND unnameable.
//
// ── THE RULE THIS SERVICE EXISTS TO ENFORCE ─────────────────────────────────
// Never delete a key without first proving no OTHER row still references it.
//
// That is not defensive padding, it is load-bearing. duplicatePiece() copies
// slicer_file_url onto every duplicate (see buildCreateInputFromPiece), so
// "duplicate x20" produces twenty rows sharing ONE object key. A delete path
// that removed "the files referenced by the rows I just deleted" would destroy
// the G-code twenty live pieces still point at; they would keep reading as
// ready, keep scheduling, and 404 at the printer. Filtering through
// unreferencedKeys() makes that impossible no matter how many aliasing sources
// exist now or appear later.
//
// ── WHY DELETION GOES THROUGH THE STORAGE API, NEVER SQL ────────────────────
// Supabase is explicit: "Deleting objects should always be done via the Storage
// API and NOT via a SQL query." A DELETE against storage.objects drops the row
// and STRANDS the bytes in the backing store — still billed, and now with no
// index left that could ever find them. So: enumerate in SQL (which Supabase's
// own scaling guide recommends over list() for exactly this), delete over the
// API. remove() accepts at most 1000 keys per call, hence the batching.
// ════════════════════════════════════════════════════════════════

/** remove() accepts at most 1000 paths per call (Supabase Storage limit). */
const REMOVE_BATCH = 1000;

/**
 * Master switch for actually removing bytes. OFF unless STORAGE_DELETE_ENABLED
 * is exactly "true" — the same dry-run-first pattern as PURGE_ENABLED,
 * EMAIL_ENABLED and LICENSING_ENFORCED, and for the same reason.
 *
 * This code went into a system already running real shops. Every delete path in
 * the app now funnels through here, so a mistake anywhere in it is a mistake
 * that destroys customer files across every tenant at once, and the only lever
 * without this flag would be a redeploy. With it off, every path still runs its
 * reference check and LOGS the exact keys it would have deleted — so the
 * decision can be read off production traffic for a week before it is armed,
 * and the log is evidence rather than a promise.
 *
 * Read at call time, not construction time, so it can be flipped by a restart
 * alone without the class having cached a stale answer.
 */
function storageDeleteEnabled(): boolean {
  return (process.env.STORAGE_DELETE_ENABLED ?? "").toLowerCase() === "true";
}

// The pure helpers live in storage-keys.ts (DI-free, so cascade.ts and
// order-purge.ts can import them and `node --test` can parse them). Re-exported
// here so a caller that already holds this service needs no second import.
export {
  storageKeyFromUrl,
  keysFromRows,
  PIECE_FILE_FIELDS,
  BED_FILE_FIELDS
} from "./storage-keys";

/** Every (table, column) that can hold an uploaded-file URL. */
const URL_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: "order_pieces", column: "slicer_file_url" },
  { table: "order_pieces", column: "stl_file_url" },
  { table: "order_pieces", column: "stl_thumbnail_url" },
  { table: "print_beds", column: "slicer_file_url" },
  { table: "print_beds", column: "stl_file_url" },
  { table: "order_attachments", column: "file_url" },
  { table: "companies", column: "logo_url" }
];

/** How the reference query derives a key from a stored URL. Mirrors
 *  storageKeyFromUrl, and is the expression the partial indexes in
 *  2026-08-29_storage_key_indexes.sql are built on — change one, change both.
 *
 *  ONE DELIBERATE DIVERGENCE, verified against Postgres 18: for a URL with
 *  nothing after the marker ("/api/uploads/") or no marker at all, the TS
 *  function returns null and this expression returns ''. Harmless in both
 *  directions and left alone rather than papered over: '' can only ever match an
 *  object literally named '', which cannot exist, and removeObjects() filters
 *  empty keys out of its candidate list before either is consulted. Making the
 *  SQL return NULL instead would need a CASE wrapper on every guard and on the
 *  index expression, for no behavioural difference. */
const KEY_EXPR = (col: string) =>
  `split_part(split_part(${col}, '/uploads/', 2), '?', 1)`;

export interface RemoveResult {
  /** Keys handed to the Storage API. */
  removed: number;
  /** Candidates skipped because another row still points at them. */
  kept: number;
  /** True when at least one batch failed; the keys are in the log. */
  failed: boolean;
}

@Injectable()
export class StorageFilesService {
  private readonly logger = new Logger("StorageFilesService");
  private readonly supabase: SupabaseClient;
  private readonly bucket: string;
  /** Which of URL_COLUMNS actually exist here. Probed once; a migration that
   *  adds one is picked up on the next boot. */
  private liveColumns: ReadonlyArray<{ table: string; column: string }> | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService
  ) {
    this.supabase = createClient(
      this.config.getOrThrow<string>("SUPABASE_URL"),
      this.config.getOrThrow<string>("SUPABASE_SERVICE_ROLE_KEY")
    );
    this.bucket = process.env.SUPABASE_UPLOAD_BUCKET || "uploads";
  }

  /**
   * Whether removals actually happen (STORAGE_DELETE_ENABLED).
   *
   * Exposed for the ONE caller that must change its own behaviour when this is
   * off rather than just having its removal ignored: the retention sweep nulls
   * a piece's file columns and then asks for the bytes. Doing the first half
   * while the second is dry-run would strand those objects permanently — the
   * reference that protects them would be gone, so nothing could ever tell them
   * apart from garbage again. See FilePurgeService.purgeOrder.
   */
  get deleteEnabled(): boolean {
    return storageDeleteEnabled();
  }

  /**
   * Which URL columns exist in this database.
   *
   * Naming a column that a pending migration hasn't added yet (order_pieces
   * .stl_thumbnail_url, the print_beds file columns) raises 42703 and takes the
   * whole reference query down with it. Probing first means an absent column
   * contributes no arm — which is CORRECT, not a shortcut: if the column does
   * not exist, no row can be referencing anything through it.
   */
  private async referenceColumns(): Promise<ReadonlyArray<{ table: string; column: string }>> {
    if (this.liveColumns) return this.liveColumns;
    const { rows } = await this.db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (table_name, column_name) IN (${URL_COLUMNS.map(
            (_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`
          ).join(", ")})`,
      URL_COLUMNS.flatMap((c) => [c.table, c.column])
    );
    const present = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
    this.liveColumns = URL_COLUMNS.filter((c) => present.has(`${c.table}.${c.column}`));
    return this.liveColumns;
  }

  /**
   * Of `keys`, the ones NO row anywhere still references.
   *
   * THROWS on any database error, and every caller must let it. This is the
   * fail-CLOSED half of the rule at the top of this file: if we cannot prove a
   * key is unreferenced, we must not delete it. Swallowing the error and
   * returning the full candidate list would turn one transient database blip
   * into permanent data loss.
   *
   * The comparison derives the KEY from each stored URL rather than
   * reconstructing the URL from the key. Reconstruction has to guess the stored
   * form ("/api/uploads/...", legacy "/uploads/...", an absolute URL, one with a
   * query string) and a guess that misses reports a live file as unreferenced —
   * failing open, in the one direction that destroys data. Extraction cannot
   * miss: any URL containing "/uploads/" yields its key whatever surrounds it.
   */
  async unreferencedKeys(keys: string[]): Promise<string[]> {
    const unique = [...new Set(keys.filter((k) => k && k.length > 0))];
    if (unique.length === 0) return [];

    const columns = await this.referenceColumns();
    // No URL column exists at all — nothing can be referencing anything. Only
    // reachable on a database missing every one of these tables.
    if (columns.length === 0) return unique;

    const guards = columns
      .map(
        (c) =>
          `NOT EXISTS (SELECT 1 FROM public.${c.table} t
                        WHERE t.${c.column} IS NOT NULL
                          AND ${KEY_EXPR(`t.${c.column}`)} = c.k)`
      )
      .join("\n          AND ");

    const { rows } = await this.db.query<{ k: string }>(
      `SELECT c.k
         FROM unnest($1::text[]) AS c(k)
        WHERE ${guards}`,
      [unique]
    );
    return rows.map((r) => r.k);
  }

  /**
   * Delete objects by key, in batches of REMOVE_BATCH.
   *
   * Best-effort by design and it must stay that way: every caller runs this
   * AFTER its transaction has committed, so the rows are already gone and there
   * is nothing to roll back to. Throwing here would return a 500 for an
   * operation that actually succeeded, and the operator would reasonably retry
   * a delete on something that no longer exists.
   *
   * A failure is logged WITH THE KEYS. That log line is the only remaining
   * record of which bytes were orphaned, and it is what makes them recoverable
   * by hand. remove() is idempotent — keys already gone are not an error — so a
   * partial failure can be replayed safely from that log.
   */
  async removeObjects(keys: string[]): Promise<{ removed: number; failed: boolean }> {
    const unique = [...new Set(keys.filter((k) => k && k.length > 0))];
    if (unique.length === 0) return { removed: 0, failed: false };

    // Dry-run. The reference check has already run by the time we get here, so
    // this list is exactly what would go — not a guess at it.
    //
    // EVERY key is logged, deliberately, however many there are. For a company
    // purge this line is the ONLY record that will ever exist: the rows naming
    // those objects have already cascaded away, and the key prefix is all that
    // is left to find them by. A truncated log would be worse than none.
    if (!storageDeleteEnabled()) {
      this.logger.log(
        `[dry-run] STORAGE_DELETE_ENABLED is not "true" — would delete ` +
          `${unique.length} object(s): ${unique.join(", ")}`
      );
      return { removed: 0, failed: false };
    }

    let removed = 0;
    let failed = false;
    for (let i = 0; i < unique.length; i += REMOVE_BATCH) {
      const batch = unique.slice(i, i + REMOVE_BATCH);
      try {
        const { error } = await this.supabase.storage.from(this.bucket).remove(batch);
        if (error) throw new Error(error.message);
        removed += batch.length;
      } catch (e) {
        failed = true;
        this.logger.error(
          `storage remove failed for ${batch.length} key(s). These bytes are now ` +
            `orphaned and must be removed by hand: ${batch.join(", ")} -- ` +
            `${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    return { removed, failed };
  }

  /**
   * The delete-path entry point: given the keys a just-deleted set of rows was
   * pointing at, remove only those nothing else references.
   *
   * Call AFTER the transaction commits. A reference-check failure removes
   * nothing and is reported, never thrown — the rows are already gone either
   * way, and leaving bytes behind is recoverable where deleting the wrong ones
   * is not.
   */
  async removeUnreferenced(keys: string[]): Promise<RemoveResult> {
    const unique = [...new Set(keys.filter((k) => k && k.length > 0))];
    if (unique.length === 0) return { removed: 0, kept: 0, failed: false };

    let deletable: string[];
    try {
      deletable = await this.unreferencedKeys(unique);
    } catch (e) {
      this.logger.error(
        `reference check failed for ${unique.length} key(s) — deleting NOTHING. ` +
          `These bytes may be orphaned: ${unique.join(", ")} -- ` +
          `${e instanceof Error ? e.message : String(e)}`
      );
      return { removed: 0, kept: unique.length, failed: true };
    }

    const kept = unique.length - deletable.length;
    const { removed, failed } = await this.removeObjects(deletable);
    return { removed, kept, failed };
  }

  /**
   * Every object key under one company's prefix.
   *
   * Read straight from storage.objects rather than through the Storage API's
   * list(): list() computes a folder hierarchy on every call and Supabase's own
   * scaling guidance is to query the table directly instead. It is also the only
   * form that is recursion-proof — a LIKE on the prefix matches at any depth,
   * where list() would need a walk per pseudo-folder.
   *
   * Object keys are "<companyId>/<uuid><ext>" (uploads.controller.ts), so the
   * prefix IS the tenant boundary. THROWS if storage.objects is unreadable —
   * the caller reports that rather than silently deleting nothing.
   */
  async keysForCompany(companyId: string): Promise<string[]> {
    const { rows } = await this.db.query<{ name: string }>(
      `SELECT name FROM storage.objects
        WHERE bucket_id = $1 AND name LIKE $2`,
      [this.bucket, `${companyId}/%`]
    );
    return rows.map((r) => r.name);
  }
}
