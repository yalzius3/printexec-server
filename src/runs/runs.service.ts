/* Batch runs — work that is too long to be an HTTP request.
   ────────────────────────────────────────────────────────────────────────
   A fleet-wide auto-schedule over a 10,000-piece backlog is ~100,000 sequential
   statements: every placement goes through the guarded schedule(), and that
   guard is precisely what must not be skipped to make it faster. Minutes of
   work cannot be a request — production reaches this API through an edge proxy
   that will not hold one open — so the request starts a RUN and returns its id,
   the work continues here, and the client polls.

   The other half of why this exists is not performance at all: an action that
   rearranges the whole shop floor should show a count that moves and offer a
   way to stop. Both are properties of a run, not of a request.

   WHAT THIS IS NOT
   A job queue. No worker pool, no retry, no dispatch across processes. The row
   in batch_runs is a progress record for work running in THIS process. That is
   a deliberate ceiling, and the honest consequences are handled rather than
   hidden:
     · a run cannot outlive the process — so a restart sweeps its row to
       'failed' with a message saying so (sweepStale below). A run that stopped
       silently is worse than one that failed loudly: the placements it already
       committed are real, and the operator has to know the rest are not coming.
     · a run is not resumable — cancelling or crashing STOPS it, it never
       unwinds it. Everything committed stays committed, which is also what the
       counts have to keep saying afterwards.

   FAILING OPEN. `available()` probes for the table. If the migration has not
   been applied the caller runs synchronously instead, exactly as before. A
   missing table must cost the progress bar, never the feature.
*/
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";

export type RunKind = "auto_schedule";
export type RunStatus = "running" | "done" | "failed" | "cancelled";

export interface RunRow {
  run_id: string;
  kind: RunKind;
  status: RunStatus;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  cancel_requested: boolean;
  result: unknown;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

/**
 * What an executor is handed. Deliberately tiny: an executor should be able to
 * say how big the job is, that it has finished another item, and to ask whether
 * it has been told to stop. Everything else — persistence, throttling, the
 * terminal state — belongs to the service.
 */
export interface RunContext {
  readonly runId: string;
  /** Called once the executor knows the size of the job. */
  setTotal(total: number): Promise<void>;
  /** One more item done. Cheap to call per item — writes are throttled. */
  advance(outcome: "succeeded" | "failed"): Promise<void>;
  /** Has someone asked this run to stop? Cheap to call per item — reads are
   *  throttled to the same cadence as the writes. */
  cancelled(): Promise<boolean>;
}

/** How often progress is actually written, in items. Progress that costs a
 *  round trip per item would add 10,000 writes to a job whose whole problem is
 *  that it already does too many. */
const PROGRESS_EVERY = 25;
/** ...and at least this often in wall-clock terms, so a run made of slow items
 *  still moves on screen. */
const PROGRESS_EVERY_MS = 1500;
/** A 'running' row older than this with no heartbeat belongs to a process that
 *  is gone. Generously larger than PROGRESS_EVERY_MS. */
const STALE_AFTER_MS = 2 * 60_000;

@Injectable()
export class RunsService {
  private readonly logger = new Logger(RunsService.name);
  /** Cached result of the table probe. Undefined = not yet asked. */
  private tableExists: boolean | undefined;

  constructor(private readonly db: DatabaseService) {}

  /** Is the batch_runs migration applied? Cached after the first answer, so a
   *  deployment that applies it mid-life needs a restart to notice — which is
   *  the same rule every other schema probe in this codebase follows. */
  async available(): Promise<boolean> {
    if (this.tableExists !== undefined) return this.tableExists;
    try {
      const res = await this.db.query<{ ok: boolean }>(
        `SELECT to_regclass('public.batch_runs') IS NOT NULL AS ok`,
      );
      this.tableExists = res.rows[0]?.ok === true;
    } catch {
      // The probe itself failed — a connection blip, not an answer about the
      // schema. Deliberately NOT cached: caching it would disable runs for the
      // lifetime of the process because the database hiccupped once at boot.
      // A missing table, by contrast, is a real answer (to_regclass returns
      // NULL rather than erroring) and IS cached.
      return false;
    }
    if (!this.tableExists) {
      this.logger.warn(
        "batch_runs is missing — long operations will run synchronously. " +
        "Apply migrations/2026-08-21_batch_runs.sql to enable progress and cancellation.",
      );
    }
    return this.tableExists;
  }

  /**
   * Start a run and return its id immediately.
   *
   * `execute` runs detached: this method does NOT await it. That is the whole
   * point — the caller's HTTP request returns while the work continues. Every
   * failure path inside is therefore caught and written to the row, because
   * there is no caller left to throw to.
   */
  async start<T>(
    companyId: string,
    userId: string | null,
    kind: RunKind,
    input: unknown,
    execute: (ctx: RunContext) => Promise<T>,
  ): Promise<string> {
    const res = await this.db.query<{ run_id: string }>(
      `INSERT INTO batch_runs (company_id, kind, input, created_by)
       VALUES ($1, $2, $3::jsonb, $4)
       RETURNING run_id`,
      [companyId, kind, JSON.stringify(input ?? {}), userId],
    );
    const runId = res.rows[0]!.run_id;
    const { ctx, flushNow } = this.makeContext(runId);

    // Detached on purpose. `void` rather than a floating promise so the intent
    // is legible, and the catch is exhaustive so a run can never end by
    // vanishing.
    void (async () => {
      try {
        const result = await execute(ctx);
        // The last partial batch of progress has not been written yet — without
        // this a run that finished would still show the count it had at its
        // last flush, which reads as "stopped short".
        await flushNow();
        const stopped = await this.isCancelRequested(runId);
        await this.finish(runId, stopped ? "cancelled" : "done", result, null);
      } catch (e) {
        const message = e instanceof Error ? e.message : "The run failed.";
        this.logger.error(`Run ${runId} (${kind}) failed: ${message}`);
        await this.finish(runId, "failed", null, message).catch(() => {
          // Even the failure write failed — the sweep will catch this row.
        });
      }
    })();

    return runId;
  }

  async get(companyId: string, runId: string): Promise<RunRow> {
    const res = await this.db.query<RunRow>(
      `SELECT run_id, kind, status, total, processed, succeeded, failed,
              cancel_requested, result, error,
              created_at::text AS created_at, finished_at::text AS finished_at
         FROM batch_runs
        WHERE company_id = $1 AND run_id = $2`,
      [companyId, runId],
    );
    const row = res.rows[0];
    if (!row) throw new NotFoundException("Run not found.");
    return row;
  }

  /**
   * Ask a run to stop.
   *
   * Sets a flag; the executor notices between items. It does NOT roll anything
   * back: a cancelled pack keeps every placement it already committed, and the
   * counts on the row say how many that was. Undoing them would be a second,
   * bigger batch operation — and one the operator did not ask for.
   */
  async cancel(companyId: string, runId: string): Promise<RunRow> {
    await this.db.query(
      `UPDATE batch_runs SET cancel_requested = true
        WHERE company_id = $1 AND run_id = $2 AND status = 'running'`,
      [companyId, runId],
    );
    return this.get(companyId, runId);
  }

  /**
   * Mark runs abandoned by a dead process as failed. Called at boot.
   *
   * A row still reading 'running' after a restart describes work that stopped
   * without saying so. Its placements are committed and its remainder is never
   * coming, so it must not sit on screen claiming to be in progress.
   */
  async sweepStale(): Promise<number> {
    if (!(await this.available())) return 0;
    try {
      const res = await this.db.query(
        `UPDATE batch_runs
            SET status = 'failed',
                finished_at = now(),
                error = COALESCE(error,
                  'The server restarted while this run was in progress. Anything it had already committed is saved; the rest was not run.')
          WHERE status = 'running'
            AND heartbeat_at < now() - ($1::int * interval '1 millisecond')`,
        [STALE_AFTER_MS],
      );
      const n = res.rowCount ?? 0;
      if (n > 0) this.logger.warn(`Swept ${n} batch run(s) abandoned by a previous process.`);
      return n;
    } catch (e) {
      this.logger.warn(`Could not sweep stale batch runs: ${e instanceof Error ? e.message : e}`);
      return 0;
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private makeContext(runId: string): { ctx: RunContext; flushNow: () => Promise<void> } {
    let sinceWrite = 0;
    let lastWriteAt = 0;
    let succeeded = 0;
    let failed = 0;
    let cancelKnown = false;
    const self = this;

    const flush = async (): Promise<void> => {
      sinceWrite = 0;
      lastWriteAt = Date.now();
      const res = await self.db.query<{ cancel_requested: boolean }>(
        `UPDATE batch_runs
            SET processed = $2, succeeded = $3, failed = $4, heartbeat_at = now()
          WHERE run_id = $1
        RETURNING cancel_requested`,
        [runId, succeeded + failed, succeeded, failed],
      );
      cancelKnown = res.rows[0]?.cancel_requested === true;
    };

    const ctx: RunContext = {
      runId,
      async setTotal(total: number) {
        await self.db.query(
          `UPDATE batch_runs SET total = $2, heartbeat_at = now() WHERE run_id = $1`,
          [runId, total],
        );
      },
      async advance(outcome) {
        if (outcome === "succeeded") succeeded += 1;
        else failed += 1;
        sinceWrite += 1;
        // The same write that reports progress reads the cancel flag back, so
        // watching for a stop costs no extra round trip.
        if (sinceWrite >= PROGRESS_EVERY || Date.now() - lastWriteAt >= PROGRESS_EVERY_MS) {
          await flush();
        }
      },
      async cancelled() {
        // Answers from what the last progress write returned. A cancel is
        // noticed within one PROGRESS_EVERY window, which on work this size is
        // a moment — and asking the database per item would reintroduce exactly
        // the per-item round trip this whole design exists to remove.
        return cancelKnown;
      },
    };
    return { ctx, flushNow: flush };
  }

  private async isCancelRequested(runId: string): Promise<boolean> {
    const res = await this.db.query<{ cancel_requested: boolean }>(
      `SELECT cancel_requested FROM batch_runs WHERE run_id = $1`,
      [runId],
    );
    return res.rows[0]?.cancel_requested === true;
  }

  private async finish(
    runId: string,
    status: Exclude<RunStatus, "running">,
    result: unknown,
    error: string | null,
  ): Promise<void> {
    await this.db.query(
      `UPDATE batch_runs
          SET status = $2,
              result = $3::jsonb,
              error = $4,
              finished_at = now(),
              heartbeat_at = now()
        WHERE run_id = $1`,
      [runId, status, result === null || result === undefined ? null : JSON.stringify(result), error],
    );
  }
}
