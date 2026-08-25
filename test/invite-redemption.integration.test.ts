// Integration tests for the ORDER of statements inside the invite-redemption
// transaction. Against a real Postgres.
//
// The bug: the transaction claimed the invite FIRST —
//
//     UPDATE company_invites SET used_at = now(), used_by = <this account>
//     INSERT INTO users (id, ...) VALUES (<this account>, ...)
//
// — so used_by was written before the users row it references existed.
// company_invites.used_by is a foreign key onto users(id), the same reference
// that made removeStaffMember die on RESTRICT (see invite-revocation). Every
// redemption therefore raised 23503 foreign_key_violation, the whole
// transaction rolled back, and the invite stayed UNUSED and still listed in
// the owner's window — while the invitee was told the request "references a
// record that does not exist".
//
// It was invisible until d868afb. While redemption compared codes byte for
// byte, nothing ever got past the 404 to reach this transaction at all, which
// is exactly why used_by had no proven writer. Fixing the match unmasked it.
//
// company_invites is not created by any migration in this repo, so whether
// used_by carries the FK is not knowable from source. These tests run both
// variants and assert the fixed order works either way — the point is that the
// ordering must not DEPEND on the answer.
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

const { Pool } = pg;

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = `invite_redeem_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const COMPANY = "22222222-2222-2222-2222-222222222222";
const OWNER = "33333333-3333-3333-3333-333333333333";
const JOINER = "44444444-4444-4444-4444-444444444444";
const RIVAL = "55555555-5555-5555-5555-555555555555";
const TOKEN = "MSY5-C3NK";

describe("invite redemption transaction ordering", { skip: !TEST_DB_URL }, () => {
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

  /**
   * Build a miniature users + company_invites + company_memberships set with a
   * given used_by foreign-key clause, seeded with one owner and one live
   * unused invite. `label` keeps each variant's tables distinct.
   */
  async function seed(usedByFk: string, label: string) {
    const users = `"${SCHEMA}".u_${label}`;
    const invites = `"${SCHEMA}".ci_${label}`;
    const members = `"${SCHEMA}".cm_${label}`;

    await pool.query(`DROP TABLE IF EXISTS ${members}, ${invites}, ${users} CASCADE`);
    await pool.query(
      `CREATE TABLE ${users} (
         id UUID PRIMARY KEY,
         company_id UUID NOT NULL,
         email TEXT,
         display_name TEXT,
         role TEXT,
         permissions JSONB DEFAULT '{}'::jsonb,
         companies_joined UUID[] DEFAULT '{}'
       )`
    );
    await pool.query(
      `CREATE TABLE ${invites} (
         token       TEXT PRIMARY KEY,
         company_id  UUID NOT NULL,
         created_by  UUID,
         used_at     TIMESTAMPTZ,
         used_by     UUID ${usedByFk.replace("__USERS__", users)},
         expires_at  TIMESTAMPTZ NOT NULL DEFAULT now() + interval '48 hours'
       )`
    );
    await pool.query(
      `CREATE TABLE ${members} (
         company_id UUID NOT NULL,
         account_id UUID NOT NULL,
         role TEXT,
         permissions JSONB DEFAULT '{}'::jsonb,
         PRIMARY KEY (company_id, account_id)
       )`
    );

    await pool.query(
      `INSERT INTO ${users} (id, company_id, email, display_name, role)
       VALUES ($1, $2, 'owner@example.com', 'Owner', 'owner')`,
      [OWNER, COMPANY]
    );
    await pool.query(
      `INSERT INTO ${invites} (token, company_id, created_by) VALUES ($1, $2, $3)`,
      [TOKEN, COMPANY, OWNER]
    );

    return { users, invites, members };
  }

  /** The transaction as it was written BEFORE the fix: claim, then insert. */
  async function redeemClaimFirst(t: Awaited<ReturnType<typeof seed>>, userId: string) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const claimed = await client.query(
        `UPDATE ${t.invites} SET used_at = now(), used_by = $1
          WHERE token = $2 AND used_at IS NULL`,
        [userId, TOKEN]
      );
      if (!claimed.rowCount) throw new Error("ALREADY_USED");
      await client.query(
        `INSERT INTO ${t.users} (id, company_id, email, display_name, role)
         VALUES ($1, $2, 'joiner@example.com', 'Joiner', 'staff')`,
        [userId, COMPANY]
      );
      await client.query(
        `INSERT INTO ${t.members} (company_id, account_id, role) VALUES ($1, $2, 'staff')`,
        [COMPANY, userId]
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /** The transaction as it is written AFTER the fix: insert, then claim. */
  async function redeemInsertFirst(t: Awaited<ReturnType<typeof seed>>, userId: string) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO ${t.users} (id, company_id, email, display_name, role)
         VALUES ($1, $2, 'joiner@example.com', 'Joiner', 'staff')`,
        [userId, COMPANY]
      );
      const claimed = await client.query(
        `UPDATE ${t.invites} SET used_at = now(), used_by = $1
          WHERE token = $2 AND used_at IS NULL`,
        [userId, TOKEN]
      );
      if (!claimed.rowCount) throw new Error("ALREADY_USED");
      await client.query(
        `INSERT INTO ${t.members} (company_id, account_id, role) VALUES ($1, $2, 'staff')`,
        [COMPANY, userId]
      );
      await client.query(
        `UPDATE ${t.users} SET companies_joined = array_append(companies_joined, $1::uuid)
          WHERE id = $2`,
        [COMPANY, userId]
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // ── The bug itself ──────────────────────────────────────────────
  it("claim-first raises 23503 when used_by references users — the reported failure", async () => {
    const t = await seed("REFERENCES __USERS__(id)", "fk_old");
    await assert.rejects(
      () => redeemClaimFirst(t, JOINER),
      (err: unknown) => (err as { code?: string }).code === "23503",
      "expected a foreign_key_violation from writing used_by before the users row exists"
    );

    // And the tell that matches the symptom exactly: the invite is untouched,
    // so it stays live and still listed in the owner's window afterwards.
    const { rows } = await pool.query(
      `SELECT used_at, used_by FROM ${t.invites} WHERE token = $1`,
      [TOKEN]
    );
    assert.equal(rows[0].used_at, null, "invite must roll back to unused");
    assert.equal(rows[0].used_by, null);
  });

  // ── The fix, under both schema variants ─────────────────────────
  for (const [label, fk, describeFk] of [
    ["fk_new", "REFERENCES __USERS__(id)", "with the foreign key"],
    ["nofk_new", "", "without any foreign key"]
  ] as const) {
    it(`insert-first redeems cleanly ${describeFk}`, async () => {
      const t = await seed(fk, label);
      await redeemInsertFirst(t, JOINER);

      const inv = await pool.query(
        `SELECT used_at, used_by FROM ${t.invites} WHERE token = $1`,
        [TOKEN]
      );
      assert.notEqual(inv.rows[0].used_at, null, "invite should be claimed");
      assert.equal(inv.rows[0].used_by, JOINER);

      const u = await pool.query(`SELECT company_id, companies_joined FROM ${t.users} WHERE id = $1`, [JOINER]);
      assert.equal(u.rows.length, 1, "joiner should have a users row");
      assert.equal(u.rows[0].company_id, COMPANY);
      assert.deepEqual(u.rows[0].companies_joined, [COMPANY]);

      const m = await pool.query(
        `SELECT 1 FROM ${t.members} WHERE company_id = $1 AND account_id = $2`,
        [COMPANY, JOINER]
      );
      assert.equal(m.rows.length, 1, "joiner should have a membership");
    });
  }

  // ── The property the old ordering was there to protect ──────────
  it("still admits exactly one winner when two people race the same code", async () => {
    const t = await seed("REFERENCES __USERS__(id)", "race");

    const results = await Promise.allSettled([
      redeemInsertFirst(t, JOINER),
      redeemInsertFirst(t, RIVAL)
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    assert.equal(won.length, 1, "exactly one racer may redeem the code");

    const inv = await pool.query(`SELECT used_by FROM ${t.invites} WHERE token = $1`, [TOKEN]);
    const winner = inv.rows[0].used_by;
    assert.ok(winner === JOINER || winner === RIVAL);

    // The loser must leave NOTHING behind — the whole point of one transaction.
    const loser = winner === JOINER ? RIVAL : JOINER;
    const stray = await pool.query(`SELECT 1 FROM ${t.users} WHERE id = $1`, [loser]);
    assert.equal(stray.rows.length, 0, "the losing racer's users row must roll back");
    const strayMember = await pool.query(
      `SELECT 1 FROM ${t.members} WHERE account_id = $1`,
      [loser]
    );
    assert.equal(strayMember.rows.length, 0, "the losing racer's membership must roll back");
  });
});
