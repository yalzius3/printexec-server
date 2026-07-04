// Integration tests for the atomic order-number sequence. These call the SAME
// bumpOrderSequence() the service uses in production (imported below — not a
// copy of the SQL) against a real Postgres in a throwaway schema, and cover the
// four behaviours the spec calls out:
//   - the sequence increments correctly,
//   - it resets when the year changes,
//   - different tenants have independent counters,
//   - concurrent requests can never generate duplicates.
//
// SAFETY: this requires a *dedicated* database and is skipped unless
// TEST_DATABASE_URL is set. It intentionally does NOT fall back to DATABASE_URL
// so it can never run against production. It creates an isolated schema, does
// all its work there, and drops it on teardown.
//
// Run (example, local Postgres):
//   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
//     node --test "test/order-numbering.integration.test.ts"

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
// The production code path — imported, so the test cannot drift from it.
import { bumpOrderSequence } from "../src/orders/order-number.ts";

const { Pool } = pg;

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const isLocal = !!TEST_DB_URL && /localhost|127\.0\.0\.1|::1/.test(TEST_DB_URL);
// Unique, lower-case schema so parallel runs / leftovers never collide.
const SCHEMA = `ord_seq_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const SEQ_TABLE = `"${SCHEMA}".order_number_sequences`;

const randomCompany = () => randomUUID();

describe(
  "order number sequence (integration)",
  { skip: TEST_DB_URL ? false : "set TEST_DATABASE_URL to run" },
  () => {
    let pool: InstanceType<typeof Pool>;

    // Run the production bumpOrderSequence() on its own transaction+connection,
    // so parallel calls genuinely contend on the counter row — exactly the
    // contention two concurrent order creations would have. The pool's
    // search_path points bumpOrderSequence's unqualified table reference at our
    // throwaway schema.
    async function nextSequence(companyId: string, year: number): Promise<number> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const value = await bumpOrderSequence(
          (sql, values) => client.query(sql, values),
          companyId,
          year
        );
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    before(async () => {
      pool = new Pool({
        connectionString: TEST_DB_URL,
        max: 12,
        ssl: isLocal ? false : { rejectUnauthorized: false },
        // Every connection resolves the unqualified `order_number_sequences` in
        // the shared SQL to our isolated schema (never a real table).
        options: `-c search_path=${SCHEMA},public`,
      });
      await pool.query(`CREATE SCHEMA "${SCHEMA}"`);
      await pool.query(`
        CREATE TABLE ${SEQ_TABLE} (
          company_id UUID    NOT NULL,
          year       INTEGER NOT NULL,
          last_value BIGINT  NOT NULL DEFAULT 0,
          PRIMARY KEY (company_id, year)
        )
      `);
    });

    after(async () => {
      if (pool) {
        await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => undefined);
        await pool.end();
      }
    });

    it("increments the sequence one step at a time", async () => {
      const company = randomCompany();
      assert.equal(await nextSequence(company, 2026), 1);
      assert.equal(await nextSequence(company, 2026), 2);
      assert.equal(await nextSequence(company, 2026), 3);
      assert.equal(await nextSequence(company, 2026), 4);
    });

    it("resets to 1 when the year changes", async () => {
      const company = randomCompany();
      assert.equal(await nextSequence(company, 2026), 1);
      assert.equal(await nextSequence(company, 2026), 2);
      // New calendar year -> fresh counter, independent of 2026.
      assert.equal(await nextSequence(company, 2027), 1);
      assert.equal(await nextSequence(company, 2027), 2);
      // ...and the old year keeps counting from where it left off.
      assert.equal(await nextSequence(company, 2026), 3);
    });

    it("keeps a separate counter per tenant", async () => {
      const tenantA = randomCompany();
      const tenantB = randomCompany();
      assert.equal(await nextSequence(tenantA, 2026), 1);
      assert.equal(await nextSequence(tenantA, 2026), 2);
      // Tenant B is untouched by tenant A's activity.
      assert.equal(await nextSequence(tenantB, 2026), 1);
      assert.equal(await nextSequence(tenantA, 2026), 3);
      assert.equal(await nextSequence(tenantB, 2026), 2);
    });

    it("never hands out a duplicate under concurrency", async () => {
      const company = randomCompany();
      const N = 100;

      // Fire N bumps at once; the pool multiplexes them over its connections so
      // many transactions contend on the same counter row simultaneously.
      const results = await Promise.all(
        Array.from({ length: N }, () => nextSequence(company, 2026))
      );

      const unique = new Set(results);
      assert.equal(unique.size, N, "every concurrent request must get a distinct value");

      // No gaps and no repeats: the set must be exactly {1, 2, ..., N}.
      const sorted = [...results].sort((a, b) => a - b);
      assert.deepEqual(
        sorted,
        Array.from({ length: N }, (_, i) => i + 1)
      );
    });

    it("keeps tenants independent even under concurrent load", async () => {
      const tenantA = randomCompany();
      const tenantB = randomCompany();
      const N = 50;

      const mixed = Array.from({ length: N }, (_, i) =>
        (i % 2 === 0
          ? nextSequence(tenantA, 2026)
          : nextSequence(tenantB, 2026)
        ).then((value) => ({ tenant: i % 2 === 0 ? "A" : "B", value }))
      );
      const settled = await Promise.all(mixed);

      const aValues = settled.filter((r) => r.tenant === "A").map((r) => r.value).sort((a, b) => a - b);
      const bValues = settled.filter((r) => r.tenant === "B").map((r) => r.value).sort((a, b) => a - b);

      assert.deepEqual(aValues, Array.from({ length: N / 2 }, (_, i) => i + 1));
      assert.deepEqual(bValues, Array.from({ length: N / 2 }, (_, i) => i + 1));
    });
  }
);
