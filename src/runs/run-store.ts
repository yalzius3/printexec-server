/* Every statement a batch run is made of — pure, no Nest, no pool.
   ────────────────────────────────────────────────────────────────────────
   Extracted from RunsService for the same reason packing.ts was extracted from
   autoSchedule: the part that is easy to get subtly wrong is the SQL, and the
   SQL was the part that could not be tested. RunsService is a Nest provider
   with a parameter-property constructor, which `node --test` cannot even import
   (strip-only mode rejects parameter properties), so anything living inside it
   is unreachable from a test by construction.

   Here it is reachable. test/batch-runs.integration.test.ts calls these exact
   functions against a real Postgres — imported, not copied, so the test cannot
   drift from what production runs.

   What the split leaves behind in the service: dependency injection, the cached
   table probe, the detached execution, and the progress throttling. What moves
   here: the statements, and the shape of a run.

   THE CONSTRAINTS THESE STATEMENTS LIVE UNDER (see the migration):
     · chk_batch_runs_finished — a row is 'running' if and only if finished_at
       is NULL. So a progress write must never touch status, and a terminal
       write must set both. This is not incidental: a progress write violating a
       constraint would kill a run mid-commit, after real placements had landed.
     · counts are non-negative, and they SURVIVE a cancel — a stopped run still
       has to say how much it committed before it stopped.
*/
import type { QueryResult, QueryResultRow } from "pg";

/** The same executor shape the cascade helpers take: a pool, a client, or a
 *  test's own connection. */
export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<QueryResult<T>>;
}

export type RunKind = "auto_schedule";
export type RunStatus = "running" | "done" | "failed" | "cancelled";
/** Every state a run can END in. 'running' is deliberately not one. */
export type TerminalRunStatus = Exclude<RunStatus, "running">;

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

/** The message a run gets when the process that was running it went away.
 *  Exported so the test asserts the real string rather than a paraphrase. */
export const RESTART_MESSAGE =
  "The server restarted while this run was in progress. " +
  "Anything it had already committed is saved; the rest was not run.";

/** Is the batch_runs migration applied to this database? Never throws for a
 *  missing table — to_regclass returns NULL rather than erroring — so a thrown
 *  error here means the probe itself failed, which the caller distinguishes.
 *
 *  Unqualified on purpose: it resolves through search_path, which is what lets
 *  the integration test point every statement here at a throwaway schema. In
 *  production search_path reaches public, so this asks the same question. */
export async function runsTableExists(db: Queryable): Promise<boolean> {
  const res = await db.query<{ ok: boolean }>(
    `SELECT to_regclass('batch_runs') IS NOT NULL AS ok`,
  );
  return res.rows[0]?.ok === true;
}

export async function insertRun(
  db: Queryable,
  input: { companyId: string; kind: RunKind; input: unknown; userId: string | null },
): Promise<string> {
  const res = await db.query<{ run_id: string }>(
    `INSERT INTO batch_runs (company_id, kind, input, created_by)
     VALUES ($1, $2, $3::jsonb, $4)
     RETURNING run_id`,
    [input.companyId, input.kind, JSON.stringify(input.input ?? {}), input.userId],
  );
  return res.rows[0]!.run_id;
}

export async function readRun(
  db: Queryable,
  companyId: string,
  runId: string,
): Promise<RunRow | null> {
  const res = await db.query<RunRow>(
    `SELECT run_id, kind, status, total, processed, succeeded, failed,
            cancel_requested, result, error,
            created_at::text AS created_at, finished_at::text AS finished_at
       FROM batch_runs
      WHERE company_id = $1 AND run_id = $2`,
    [companyId, runId],
  );
  return res.rows[0] ?? null;
}

/** The size of the job, once the executor knows it. Touches nothing else. */
export async function writeTotal(db: Queryable, runId: string, total: number): Promise<void> {
  await db.query(
    `UPDATE batch_runs SET total = $2, heartbeat_at = now() WHERE run_id = $1`,
    [runId, total],
  );
}

/**
 * Write progress AND read the cancel flag back in one round trip.
 *
 * One statement rather than two on purpose: this runs hundreds of times during
 * a long run, and watching for a stop should not cost a second query every
 * time. Returns whether a cancel has been requested — false if the row is gone.
 *
 * Deliberately does not touch `status` or `finished_at`, so it cannot trip
 * chk_batch_runs_finished on a row that is still running.
 */
export async function writeProgress(
  db: Queryable,
  runId: string,
  counts: { succeeded: number; failed: number },
): Promise<boolean> {
  const res = await db.query<{ cancel_requested: boolean }>(
    `UPDATE batch_runs
        SET processed = $2, succeeded = $3, failed = $4, heartbeat_at = now()
      WHERE run_id = $1
    RETURNING cancel_requested`,
    [runId, counts.succeeded + counts.failed, counts.succeeded, counts.failed],
  );
  return res.rows[0]?.cancel_requested === true;
}

/**
 * Ask a run to stop. Only a RUNNING run can be asked — a finished one has
 * nothing left to stop, and flagging it would misreport what happened.
 *
 * This sets a flag. It does not roll anything back: a stopped pack keeps every
 * placement it committed, and the counts on the row are how the operator learns
 * how many that was.
 */
export async function requestCancel(
  db: Queryable,
  companyId: string,
  runId: string,
): Promise<void> {
  await db.query(
    `UPDATE batch_runs SET cancel_requested = true
      WHERE company_id = $1 AND run_id = $2 AND status = 'running'`,
    [companyId, runId],
  );
}

export async function isCancelRequested(db: Queryable, runId: string): Promise<boolean> {
  const res = await db.query<{ cancel_requested: boolean }>(
    `SELECT cancel_requested FROM batch_runs WHERE run_id = $1`,
    [runId],
  );
  return res.rows[0]?.cancel_requested === true;
}

/** End a run. Sets status and finished_at together, which is what
 *  chk_batch_runs_finished requires. */
export async function finishRun(
  db: Queryable,
  runId: string,
  status: TerminalRunStatus,
  result: unknown,
  error: string | null,
): Promise<void> {
  await db.query(
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

/**
 * Fail every run whose process is gone, and say why.
 *
 * A row still reading 'running' after a restart describes work that stopped
 * without saying so — its placements are committed and its remainder is never
 * coming. Leaving it on screen claiming to be in progress is the one outcome
 * worse than a run that failed loudly.
 *
 * COALESCE on the message so a run that already recorded a reason keeps it.
 * Returns how many were swept.
 */
export async function sweepStaleRuns(db: Queryable, staleAfterMs: number): Promise<number> {
  const res = await db.query(
    `UPDATE batch_runs
        SET status = 'failed',
            finished_at = now(),
            error = COALESCE(error, $2)
      WHERE status = 'running'
        AND heartbeat_at < now() - ($1::int * interval '1 millisecond')`,
    [staleAfterMs, RESTART_MESSAGE],
  );
  return res.rowCount ?? 0;
}
