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

   WHERE THE PIECES LIVE
   Every statement is in run-store.ts, which has no Nest in it and can therefore
   be imported by a test — this class cannot, because strip-only TypeScript
   refuses parameter-property constructors. What stays here is the wiring: the
   cached table probe, the detached execution, and the progress throttling.

   WHAT THIS IS NOT
   A job queue. No worker pool, no retry, no dispatch across processes. The row
   in batch_runs is a progress record for work running in THIS process. That is
   a deliberate ceiling, and the honest consequences are handled rather than
   hidden:
     · a run cannot outlive the process — so a restart sweeps its row to
       'failed' with a message saying so. A run that stopped silently is worse
       than one that failed loudly: the placements it already committed are
       real, and the operator has to know the rest are not coming.
     · a run is not resumable — cancelling or crashing STOPS it, it never
       unwinds it. Everything committed stays committed, which is also what the
       counts have to keep saying afterwards.

   FAILING OPEN. `available()` probes for the table. If the migration has not
   been applied the caller runs synchronously instead, exactly as before. A
   missing table must cost the progress bar, never the feature.
*/
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import {
  finishRun,
  insertRun,
  isCancelRequested,
  readRun,
  requestCancel,
  runsTableExists,
  sweepStaleRuns,
  writeProgress,
  writeTotal,
  type RunKind,
  type RunRow,
  type TerminalRunStatus,
} from "./run-store";

export type { RunKind, RunRow, RunStatus } from "./run-store";

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
  /** Has someone asked this run to stop? Cheap to call per item — the answer
   *  comes from the last progress write, which reads the flag back. */
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
   *  deployment that applies it mid-life needs a restart to notice — the same
   *  rule every other schema probe in this codebase follows. */
  async available(): Promise<boolean> {
    if (this.tableExists !== undefined) return this.tableExists;
    try {
      this.tableExists = await runsTableExists(this.db);
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
    const runId = await insertRun(this.db, { companyId, kind, input, userId });
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
        const stopped = await isCancelRequested(this.db, runId);
        await finishRun(this.db, runId, stopped ? "cancelled" : "done", result, null);
      } catch (e) {
        const message = e instanceof Error ? e.message : "The run failed.";
        this.logger.error(`Run ${runId} (${kind}) failed: ${message}`);
        await this.finishQuietly(runId, "failed", null, message);
      }
    })();

    return runId;
  }

  async get(companyId: string, runId: string): Promise<RunRow> {
    const row = await readRun(this.db, companyId, runId);
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
    await requestCancel(this.db, companyId, runId);
    return this.get(companyId, runId);
  }

  /**
   * Mark runs abandoned by a dead process as failed. Called at boot.
   */
  async sweepStale(): Promise<number> {
    if (!(await this.available())) return 0;
    try {
      const n = await sweepStaleRuns(this.db, STALE_AFTER_MS);
      if (n > 0) this.logger.warn(`Swept ${n} batch run(s) abandoned by a previous process.`);
      return n;
    } catch (e) {
      this.logger.warn(`Could not sweep stale batch runs: ${e instanceof Error ? e.message : e}`);
      return 0;
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * The throttle. Counts in memory and writes rarely, because the run's whole
   * problem is the number of statements it already issues — and because the
   * progress write is also the cancel READ, one round trip does both.
   */
  private makeContext(runId: string): { ctx: RunContext; flushNow: () => Promise<void> } {
    let sinceWrite = 0;
    let lastWriteAt = 0;
    let succeeded = 0;
    let failed = 0;
    let cancelKnown = false;
    const db = this.db;

    const flush = async (): Promise<void> => {
      sinceWrite = 0;
      lastWriteAt = Date.now();
      cancelKnown = await writeProgress(db, runId, { succeeded, failed });
    };

    const ctx: RunContext = {
      runId,
      async setTotal(total: number) {
        await writeTotal(db, runId, total);
      },
      async advance(outcome) {
        if (outcome === "succeeded") succeeded += 1;
        else failed += 1;
        sinceWrite += 1;
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

  /** Record a terminal state, swallowing a failure to do so. Used only on the
   *  error path, where there is no caller left to tell: if even this write
   *  fails the row stays 'running' and the boot sweep will catch it. */
  private async finishQuietly(
    runId: string,
    status: TerminalRunStatus,
    result: unknown,
    error: string | null,
  ): Promise<void> {
    try {
      await finishRun(this.db, runId, status, result, error);
    } catch {
      /* the sweep is the backstop */
    }
  }
}
