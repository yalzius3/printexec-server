// Integration tests for the batch-run store. These call the SAME functions
// RunsService uses in production (imported below — not a copy of the SQL)
// against a real Postgres, with the real migration applied into a throwaway
// schema.
//
// WHY THESE EXIST. The auto-schedule commit path writes to this table hundreds
// of times per run, under three CHECK constraints, while real print placements
// are landing on the board. Everything about that had been type-checked and
// reasoned about and nothing about it had ever executed. The specific failure
// this guards against: a progress write that violates a constraint would kill a
// run halfway, AFTER committing work, leaving the row claiming to be running.
//
// SAFETY: requires a *dedicated* database and is skipped unless
// TEST_DATABASE_URL is set. It intentionally does NOT fall back to DATABASE_URL
// so it can never run against production. It creates an isolated schema, does
// all its work there, and drops it on teardown.
//
// Run:  npm run test:integration      (spins up an embedded Postgres)

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
// The production code path — imported, so the test cannot drift from it.
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
  RESTART_MESSAGE,
} from "../src/runs/run-store.ts";

const { Pool } = pg;

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const isLocal = !!TEST_DB_URL && /localhost|127\.0\.0\.1|::1/.test(TEST_DB_URL);
const SCHEMA = `batch_runs_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const MIGRATION = path.join(process.cwd(), "migrations", "2026-08-21_batch_runs.sql");

describe(
  "batch runs (integration)",
  { skip: TEST_DB_URL ? false : "set TEST_DATABASE_URL to run" },
  () => {
    let pool: InstanceType<typeof Pool>;
    let companyId: string;
    let otherCompanyId: string;

    before(async () => {
      pool = new Pool({
        connectionString: TEST_DB_URL,
        max: 4,
        ssl: isLocal ? false : { rejectUnauthorized: false },
      });
      await pool.query(`CREATE SCHEMA "${SCHEMA}"`);
      // Every statement in run-store.ts is unqualified, so search_path is what
      // points them at the throwaway schema.
      await pool.query(`SET search_path TO "${SCHEMA}"`);
      pool.on("connect", (client) => {
        void client.query(`SET search_path TO "${SCHEMA}"`);
      });

      // The FK target. Only the column the migration references.
      await pool.query(`CREATE TABLE "${SCHEMA}".companies (company_id uuid PRIMARY KEY)`);

      // THE REAL MIGRATION, verbatim, with its public. qualifiers redirected
      // into the throwaway schema. Applying the actual file is half the point:
      // it proves the DDL that will run against production is valid.
      const sql = readFileSync(MIGRATION, "utf8").replaceAll("public.", `"${SCHEMA}".`);
      await pool.query(sql);

      companyId = randomUUID();
      otherCompanyId = randomUUID();
      await pool.query(`INSERT INTO "${SCHEMA}".companies VALUES ($1), ($2)`, [
        companyId,
        otherCompanyId,
      ]);
    });

    after(async () => {
      if (!pool) return;
      await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await pool.end();
    });

    it("the migration creates a table the code can find", async () => {
      assert.equal(await runsTableExists(pool), true);
    });

    it("a new run starts running, at zero, with no end time", async () => {
      const runId = await insertRun(pool, {
        companyId,
        kind: "auto_schedule",
        input: { items: 9000, dry_run: false },
        userId: randomUUID(),
      });
      const row = await readRun(pool, companyId, runId);
      assert.ok(row);
      assert.equal(row.status, "running");
      assert.equal(row.finished_at, null);
      assert.deepEqual(
        { total: row.total, processed: row.processed, succeeded: row.succeeded, failed: row.failed },
        { total: 0, processed: 0, succeeded: 0, failed: 0 },
      );
    });

    it("a progress write never trips a constraint, however often it runs", async () => {
      // THE ONE THAT MATTERS. chk_batch_runs_finished says a row is 'running'
      // if and only if finished_at is NULL, so a progress write that touched
      // either would kill a long run mid-commit — after real placements had
      // landed on the board.
      const runId = await insertRun(pool, {
        companyId, kind: "auto_schedule", input: {}, userId: null,
      });
      await writeTotal(pool, runId, 9000);
      for (let i = 1; i <= 40; i++) {
        const cancelled = await writeProgress(pool, runId, { succeeded: i * 25, failed: i });
        assert.equal(cancelled, false, `flush ${i} should not report a cancel`);
      }
      const row = await readRun(pool, companyId, runId);
      assert.ok(row);
      assert.equal(row.status, "running");
      assert.equal(row.finished_at, null);
      assert.equal(row.total, 9000);
      assert.equal(row.succeeded, 1000);
      assert.equal(row.failed, 40);
      // processed is derived from the two, so it can never disagree with them.
      assert.equal(row.processed, 1040);
    });

    it("a cancel is seen by the next progress write, in the same round trip", async () => {
      const runId = await insertRun(pool, {
        companyId, kind: "auto_schedule", input: {}, userId: null,
      });
      assert.equal(await writeProgress(pool, runId, { succeeded: 10, failed: 0 }), false);
      await requestCancel(pool, companyId, runId);
      assert.equal(await writeProgress(pool, runId, { succeeded: 20, failed: 0 }), true);
      assert.equal(await isCancelRequested(pool, runId), true);
    });

    it("cancelling keeps everything the run had already committed", async () => {
      // A stopped pack does not unwind. The counts and the partial plan are how
      // the operator finds out what DID land, so they have to survive.
      const runId = await insertRun(pool, {
        companyId, kind: "auto_schedule", input: {}, userId: null,
      });
      await writeProgress(pool, runId, { succeeded: 8800, failed: 200 });
      await requestCancel(pool, companyId, runId);
      await finishRun(pool, runId, "cancelled", { placed: [1, 2, 3], skipped: [] }, null);

      const row = await readRun(pool, companyId, runId);
      assert.ok(row);
      assert.equal(row.status, "cancelled");
      assert.ok(row.finished_at, "a finished run must carry an end time");
      assert.equal(row.succeeded, 8800);
      assert.equal(row.failed, 200);
      assert.deepEqual((row.result as { placed: number[] }).placed, [1, 2, 3]);
    });

    it("a run that already finished cannot be cancelled after the fact", async () => {
      const runId = await insertRun(pool, {
        companyId, kind: "auto_schedule", input: {}, userId: null,
      });
      await finishRun(pool, runId, "done", { placed: [], skipped: [] }, null);
      await requestCancel(pool, companyId, runId);
      const row = await readRun(pool, companyId, runId);
      assert.ok(row);
      assert.equal(row.status, "done");
      assert.equal(row.cancel_requested, false, "a finished run must not be flagged as stopping");
    });

    it("a failed run records the reason", async () => {
      const runId = await insertRun(pool, {
        companyId, kind: "auto_schedule", input: {}, userId: null,
      });
      await finishRun(pool, runId, "failed", null, "the printer roster went stale");
      const row = await readRun(pool, companyId, runId);
      assert.ok(row);
      assert.equal(row.status, "failed");
      assert.equal(row.error, "the printer roster went stale");
      assert.equal(row.result, null);
    });

    it("the boot sweep fails abandoned runs and leaves live ones alone", async () => {
      const abandoned = await insertRun(pool, {
        companyId, kind: "auto_schedule", input: {}, userId: null,
      });
      const live = await insertRun(pool, {
        companyId, kind: "auto_schedule", input: {}, userId: null,
      });
      // Age the abandoned one past any plausible heartbeat.
      await pool.query(
        `UPDATE batch_runs SET heartbeat_at = now() - interval '10 minutes' WHERE run_id = $1`,
        [abandoned],
      );

      const swept = await sweepStaleRuns(pool, 2 * 60_000);
      assert.equal(swept, 1, "exactly the abandoned run");

      const dead = await readRun(pool, companyId, abandoned);
      assert.ok(dead);
      assert.equal(dead.status, "failed");
      assert.ok(dead.finished_at, "a swept run must carry an end time");
      assert.equal(dead.error, RESTART_MESSAGE);

      const alive = await readRun(pool, companyId, live);
      assert.ok(alive);
      assert.equal(alive.status, "running", "a run that is merely young must be untouched");
    });

    it("the sweep keeps a reason the run had already recorded", async () => {
      const runId = await insertRun(pool, {
        companyId, kind: "auto_schedule", input: {}, userId: null,
      });
      await pool.query(
        `UPDATE batch_runs SET error = 'a real reason', heartbeat_at = now() - interval '10 minutes'
          WHERE run_id = $1`,
        [runId],
      );
      await sweepStaleRuns(pool, 2 * 60_000);
      const row = await readRun(pool, companyId, runId);
      assert.ok(row);
      assert.equal(row.error, "a real reason", "COALESCE must not overwrite a recorded reason");
    });

    it("a run belongs to one tenant and is invisible to another", async () => {
      const runId = await insertRun(pool, {
        companyId, kind: "auto_schedule", input: {}, userId: null,
      });
      assert.ok(await readRun(pool, companyId, runId));
      assert.equal(await readRun(pool, otherCompanyId, runId), null);

      // ...and one tenant cannot stop another's run.
      await requestCancel(pool, otherCompanyId, runId);
      assert.equal(await isCancelRequested(pool, runId), false);
    });

    it("the constraints actually bite", async () => {
      // Otherwise every assertion above proves only that nothing was enforced.
      const runId = await insertRun(pool, {
        companyId, kind: "auto_schedule", input: {}, userId: null,
      });
      await assert.rejects(
        () => pool.query(
          `UPDATE batch_runs SET status = 'done', finished_at = NULL WHERE run_id = $1`, [runId]),
        /chk_batch_runs_finished/,
        "a finished run with no end time must be rejected",
      );
      await assert.rejects(
        // finished_at is set, so only the status constraint can be the one that
        // fires — with it NULL the finished-at constraint fires first and the
        // test would pass for the wrong reason.
        () => pool.query(
          `INSERT INTO batch_runs (company_id, kind, status, finished_at)
           VALUES ($1, 'auto_schedule', 'wat', now())`, [companyId]),
        /chk_batch_runs_status/,
        "an unknown status must be rejected",
      );
      await assert.rejects(
        () => pool.query(
          `UPDATE batch_runs SET processed = -1 WHERE run_id = $1`, [runId]),
        /chk_batch_runs_counts/,
        "a negative count must be rejected",
      );
    });

    it("deleting a company takes its runs with it", async () => {
      const doomed = randomUUID();
      await pool.query(`INSERT INTO "${SCHEMA}".companies VALUES ($1)`, [doomed]);
      const runId = await insertRun(pool, {
        companyId: doomed, kind: "auto_schedule", input: {}, userId: null,
      });
      await pool.query(`DELETE FROM "${SCHEMA}".companies WHERE company_id = $1`, [doomed]);
      assert.equal(await readRun(pool, doomed, runId), null);
    });
  },
);
