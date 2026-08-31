// Integration test for the printer-ownership check in JobsService.assign().
//
// WHY THIS EXISTS. assign() never verified that input.printer_id belonged to
// the caller's company. For an FDM piece that was true only by ACCIDENT — the
// nozzle probe further down is scoped by company_id, so a foreign printer
// matched no row and the call failed with a message about nozzles. That whole
// branch is skipped for resin, which has no nozzle, so a resin piece could be
// assigned to another tenant's printer or to a UUID naming no printer at all.
//
// It matters more than its blast radius suggests: the API connects as a single
// privileged role, so RLS is bypassed and these company_id predicates are the
// ONLY tenant isolation there is.
//
// The check has to be exactly as permissive as the candidate list it mirrors —
// findCandidates filters on pi.company_id alone and returns offline/maintenance
// as FLAGS, not filters. A stricter check here would reject assignments that
// are legal today, which is the failure mode that costs an operator their
// afternoon. The "offline printer is still assignable" case below pins that.
//
// SAFETY: requires a dedicated database and is skipped unless TEST_DATABASE_URL
// is set. It deliberately does NOT fall back to DATABASE_URL, so it can never
// run against production. It creates an isolated schema and drops it on
// teardown.
//
// Run:  npm run test:integration

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";

const { Pool } = pg;

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = `printer_own_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

// The statement under test, byte-for-byte as jobs.service.ts sends it. The
// final test in this file reads that file and asserts this string still appears
// in it, so the two cannot drift apart silently.
const OWNERSHIP_SQL =
  "SELECT 1 FROM printer_instances WHERE company_id = $1 AND printer_id = $2";

describe(
  "assign() printer ownership (integration)",
  { skip: TEST_DB_URL ? false : "set TEST_DATABASE_URL to run" },
  () => {
    let pool: InstanceType<typeof Pool>;
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const ownPrinterId = randomUUID();
    const ownOfflinePrinterId = randomUUID();
    const otherPrinterId = randomUUID();

    before(async () => {
      pool = new Pool({ connectionString: TEST_DB_URL, max: 4 });
      await pool.query(`CREATE SCHEMA "${SCHEMA}"`);
      // The statement under test is unqualified ("FROM printer_instances"),
      // exactly as production sends it, so search_path is what points it at the
      // throwaway schema. It is per-CONNECTION, and a pool hands out whichever
      // connection is free — so setting it once would only cover whichever one
      // happened to answer, and a later query on a different connection would
      // silently read the PUBLIC schema instead. Same idiom as
      // nozzle-pool.integration.test.ts.
      await pool.query(`SET search_path TO "${SCHEMA}"`);
      pool.on("connect", (client) => {
        void client.query(`SET search_path TO "${SCHEMA}"`);
      });

      // Only the columns this statement touches. A narrower table than
      // production on purpose: the test is about the predicate, and inventing
      // the rest would only create a second schema to keep in step.
      await pool.query(`
        CREATE TABLE printer_instances (
          printer_id  uuid PRIMARY KEY,
          company_id  uuid NOT NULL,
          brand       text,
          model       text
        )
      `);
      await pool.query(
        `INSERT INTO printer_instances (printer_id, company_id, brand, model)
         VALUES ($1, $2, 'Prusa', 'MK4'),
                ($3, $2, 'Prusa', 'MK3 (offline)'),
                ($4, $5, 'Bambu', 'X1C')`,
        [ownPrinterId, companyId, ownOfflinePrinterId, otherPrinterId, otherCompanyId]
      );
    });

    after(async () => {
      if (!pool) return;
      await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await pool.end();
    });

    const check = (company: string, printer: string) =>
      pool.query(OWNERSHIP_SQL, [company, printer]);

    it("the fixture really is isolated — nothing leaked into public", async () => {
      // Pins the search_path handling above. Before it was added, the fixture
      // was created on whichever pooled connection answered first: if that was
      // not the one carrying search_path, CREATE TABLE landed in PUBLIC, the
      // assertions still passed by reading it there, and the shared test
      // database was quietly polluted for every other integration file.
      //
      // So assert the table exists where we meant it to and NOWHERE else. This
      // is the test that would have caught the bug, rather than passing through
      // it.
      const mine = await pool.query(
        `SELECT to_regclass($1) IS NOT NULL AS present`,
        [`"${SCHEMA}".printer_instances`]
      );
      assert.equal(mine.rows[0].present, true, "fixture must live in the throwaway schema");

      const leaked = await pool.query(
        `SELECT to_regclass('public.printer_instances') IS NOT NULL AS present`
      );
      assert.equal(leaked.rows[0].present, false, "fixture must NOT exist in public");
    });

    it("executes at all — the table and columns are real", async () => {
      // The failure this retires: a wrong identifier here is not a wrong
      // answer, it is a 500 on every assign, FDM and resin alike.
      const res = await check(companyId, ownPrinterId);
      assert.equal(res.rowCount, 1);
    });

    it("accepts a printer the company owns", async () => {
      const res = await check(companyId, ownPrinterId);
      assert.equal(res.rowCount, 1, "an owned printer must remain assignable");
    });

    it("accepts an owned printer regardless of offline/maintenance state", async () => {
      // findCandidates returns those as flags, not filters. If this check were
      // stricter than that, assignments that work today would start failing.
      const res = await check(companyId, ownOfflinePrinterId);
      assert.equal(res.rowCount, 1, "the check must not be stricter than findCandidates");
    });

    it("REJECTS another tenant's printer", async () => {
      const res = await check(companyId, otherPrinterId);
      assert.equal(res.rowCount, 0, "a foreign printer must not be assignable");
    });

    it("REJECTS a uuid that names no printer at all", async () => {
      const res = await check(companyId, randomUUID());
      assert.equal(res.rowCount, 0);
    });

    it("is symmetric — the other tenant cannot reach ours either", async () => {
      const res = await check(otherCompanyId, ownPrinterId);
      assert.equal(res.rowCount, 0);
    });

    it("the statement here is still the one jobs.service.ts sends", async () => {
      // Anti-drift. If the service's SQL is edited, this fails loudly rather
      // than leaving a test that passes while proving nothing about production.
      const src = readFileSync("src/jobs/jobs.service.ts", "utf8");
      assert.ok(
        src.includes(OWNERSHIP_SQL),
        "jobs.service.ts no longer contains the statement this test executes — " +
          "update both, or the proof is stale"
      );
    });
  }
);
