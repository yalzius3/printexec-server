// Integration tests for invite expiry, against a real Postgres.
//
// The bug: three places ask whether an invite is still good — the owner's
// list, the redemption path, and "email me this code" — and they used to ask
// DIFFERENTLY. The list compared in SQL; the other two re-derived it in
// JavaScript from the returned timestamp. Those agree only if
// company_invites.expires_at is `timestamptz`. If it is a naive `timestamp`,
// SQL resolves it in the database session's timezone while node-postgres
// resolves it in the API process's, and a code sitting in the owner's list
// looking perfectly live is refused at redemption as expired.
//
// company_invites is not created by any migration in this repo, so its real
// column type could not be read from source. Rather than guess, these tests
// build the table BOTH WAYS and assert the predicates agree either way — so
// the fix is correct whatever production turns out to hold. The naive-column
// cases also run under a deliberately non-UTC session timezone, which is the
// only condition under which the old code actually broke.
//
// The predicates are IMPORTED from the production module, not retyped, so the
// test cannot drift from what the service and controller actually run.
//
// SAFETY: requires a dedicated database and is skipped unless
// TEST_DATABASE_URL is set. It intentionally does NOT fall back to
// DATABASE_URL, so it can never run against production. All work happens in an
// isolated schema which is dropped on teardown.
//
// Run:  npm run test:integration

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
// The production expressions — imported, so this cannot drift from them.
import { inviteIsExpiredSql, inviteIsLiveSql } from "../src/staff/invite-token.ts";

const { Pool } = pg;

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = `invite_exp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

describe("invite expiry agrees across every call site", { skip: !TEST_DB_URL }, () => {
  let pool: InstanceType<typeof Pool>;

  before(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    await pool.query(`CREATE SCHEMA "${SCHEMA}"`);
  });

  after(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await pool.end();
    }
  });

  // Build the table with a given expires_at type, seed it the way
  // StaffService.createInvite now does (now() + interval, computed by the
  // database), and report what each call site would conclude.
  async function probe(columnType: string, sessionTimeZone: string) {
    const table = `"${SCHEMA}".ci_${columnType.replace(/\W+/g, "_")}_${sessionTimeZone.replace(/\W+/g, "_")}`.toLowerCase();
    const client = await pool.connect();
    try {
      await client.query(`SET TIME ZONE '${sessionTimeZone}'`);
      await client.query(`DROP TABLE IF EXISTS ${table}`);
      await client.query(
        `CREATE TABLE ${table} (
           token       TEXT PRIMARY KEY,
           expires_at  ${columnType},
           created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
         )`
      );
      // live: the 48h window createInvite writes. expired: 1h ago.
      // no_expiry: the NULL row both predicates must fail CLOSED on.
      await client.query(
        `INSERT INTO ${table} (token, expires_at) VALUES
           ('LIVE-AAAA', now() + interval '48 hours'),
           ('GONE-AAAA', now() - interval '1 hour'),
           ('NULL-AAAA', NULL)`
      );

      const { rows } = await client.query(
        `SELECT token,
                ${inviteIsExpiredSql("expires_at")} AS is_expired,
                ${inviteIsLiveSql("expires_at")}    AS is_live,
                -- Epoch seconds, not the interval itself: Postgres normalizes
                -- an interval of 48 hours to 2 days, so node-postgres hands
                -- back {days:2} with no hours field, and a naive check on
                -- .hours reads 0. (No backticks in here -- this is inside a
                -- template literal.)
                EXTRACT(EPOCH FROM (expires_at - created_at)) AS window_seconds
           FROM ${table}
          ORDER BY token`
      );
      return Object.fromEntries(rows.map((r) => [r.token, r]));
    } finally {
      client.release();
    }
  }

  // Both realistic column types, and for the naive one a session timezone far
  // from UTC — the exact condition that made the old code disagree with itself.
  const CASES: Array<[string, string]> = [
    ["TIMESTAMPTZ", "UTC"],
    ["TIMESTAMPTZ", "Africa/Cairo"],
    ["TIMESTAMP", "UTC"],
    ["TIMESTAMP", "Africa/Cairo"],
    ["TIMESTAMP", "America/Los_Angeles"],
  ];

  for (const [columnType, tz] of CASES) {
    describe(`${columnType} under ${tz}`, () => {
      it("the list predicate and the redemption predicate are exact complements", async () => {
        const r = await probe(columnType, tz);
        for (const token of ["LIVE-AAAA", "GONE-AAAA", "NULL-AAAA"]) {
          assert.notEqual(
            r[token].is_expired,
            r[token].is_live,
            `${token}: the owner's list and redemption disagree — this is the bug`
          );
        }
      });

      it("a fresh 48h invite is live everywhere", async () => {
        const r = await probe(columnType, tz);
        assert.equal(r["LIVE-AAAA"].is_expired, false);
        assert.equal(r["LIVE-AAAA"].is_live, true);
      });

      it("a lapsed invite is expired everywhere", async () => {
        const r = await probe(columnType, tz);
        assert.equal(r["GONE-AAAA"].is_expired, true);
        assert.equal(r["GONE-AAAA"].is_live, false);
      });

      it("a row with no expiry fails CLOSED, not eternal", async () => {
        const r = await probe(columnType, tz);
        assert.equal(r["NULL-AAAA"].is_expired, true, "NULL expiry must read as expired");
        assert.equal(r["NULL-AAAA"].is_live, false, "NULL expiry must not appear live");
      });

      it("the stored window is exactly 48 hours, not skewed by the session zone", async () => {
        const r = await probe(columnType, tz);
        // This is what breaks when expiry is computed in JS as an ISO string
        // and cast into a naive column: the Z is dropped and the window lands
        // offset by the session's UTC offset. Computing it as
        // `now() + interval` in the database keeps it exact either way.
        const seconds = Number(r["LIVE-AAAA"].window_seconds);
        assert.equal(
          seconds,
          48 * 3600,
          `window was ${seconds / 3600}h under ${tz} — a whole-hour drift here is the naive-column bug`
        );
      });
    });
  }

  it("the two predicates are complements for arbitrary offsets, not just the fixtures", async () => {
    const client = await pool.connect();
    try {
      await client.query(`SET TIME ZONE 'Africa/Cairo'`);
      // Sweep across the boundary in both directions, including exactly now().
      const { rows } = await client.query(
        `WITH t AS (
           SELECT now() + (n || ' minutes')::interval AS expires_at
             FROM generate_series(-600, 600, 37) AS n
         )
         SELECT count(*) AS total,
                count(*) FILTER (
                  WHERE ${inviteIsExpiredSql("expires_at")} = ${inviteIsLiveSql("expires_at")}
                ) AS disagreements
           FROM t`
      );
      assert.equal(Number(rows[0].total) > 0, true, "the sweep produced no rows");
      assert.equal(Number(rows[0].disagreements), 0, "the predicates overlap somewhere");
    } finally {
      client.release();
    }
  });
});
