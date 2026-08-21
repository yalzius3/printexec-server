// Integration tests for what happens to a staff member's invite codes when
// that member is removed. Against a real Postgres.
//
// The bug (finding F6): removing someone deleted their users row but left
// their outstanding invite codes redeemable for the rest of the 48-hour
// window — so a member you had just removed could still walk a stranger into
// the workspace. And because listInvites INNER JOINED users on created_by,
// those codes vanished from the owner's list the moment the row went, so they
// could not even be revoked by hand. Invisible and live is the worst pairing.
//
// company_invites is not created by any migration in this repo, so what its
// created_by foreign key does on delete is UNKNOWN — and it decides whether
// the removal sequence works at all. Rather than guess, these tests run the
// sequence under every plausible variant (RESTRICT, SET NULL, CASCADE, and no
// FK) and assert the outcome in each.
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
const SCHEMA = `invite_revoke_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const MEMBER = "11111111-1111-1111-1111-111111111111";
const COMPANY = "22222222-2222-2222-2222-222222222222";

describe("removing a member takes back their invites", { skip: !TEST_DB_URL }, () => {
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

  // Build a miniature users + company_invites pair with a given FK behaviour,
  // seed one member holding one UNUSED and one USED invite, and hand back a
  // client positioned to run the removal.
  async function seed(fkClause: string, label: string) {
    const users = `"${SCHEMA}".u_${label}`;
    const invites = `"${SCHEMA}".ci_${label}`;
    await pool.query(`DROP TABLE IF EXISTS ${invites}, ${users} CASCADE`);
    await pool.query(
      `CREATE TABLE ${users} (
         id UUID PRIMARY KEY, company_id UUID NOT NULL, display_name TEXT
       )`
    );
    await pool.query(
      `CREATE TABLE ${invites} (
         token       TEXT PRIMARY KEY,
         company_id  UUID NOT NULL,
         created_by  UUID ${fkClause.replace("__USERS__", users)},
         used_at     TIMESTAMPTZ,
         used_by     UUID,
         expires_at  TIMESTAMPTZ NOT NULL DEFAULT now() + interval '48 hours'
       )`
    );
    await pool.query(`INSERT INTO ${users} (id, company_id, display_name) VALUES ($1,$2,'Departing')`, [MEMBER, COMPANY]);
    await pool.query(
      `INSERT INTO ${invites} (token, company_id, created_by, used_at) VALUES
         ('LIVE-AAAA', $1, $2, NULL),
         ('USED-AAAA', $1, $2, now())`,
      [COMPANY, MEMBER]
    );
    return { users, invites };
  }

  // The production sequence from StaffService.removeStaffMember: one
  // transaction, unused invites first, then the member — with a savepointed
  // retry that releases created_by on the USED rows if the FK refuses.
  async function removeMember(users: string, invites: string) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM ${invites} WHERE company_id = $1 AND created_by = $2 AND used_at IS NULL`,
        [COMPANY, MEMBER]
      );
      await client.query("SAVEPOINT before_member_delete");
      try {
        await client.query(`DELETE FROM ${users} WHERE id = $1 AND company_id = $2`, [MEMBER, COMPANY]);
      } catch {
        await client.query("ROLLBACK TO SAVEPOINT before_member_delete");
        await client.query(
          `UPDATE ${invites} SET created_by = NULL
            WHERE company_id = $1 AND created_by = $2 AND used_at IS NOT NULL`,
          [COMPANY, MEMBER]
        );
        await client.query(`DELETE FROM ${users} WHERE id = $1 AND company_id = $2`, [MEMBER, COMPANY]);
      }
      await client.query("COMMIT");
      return { ok: true as const };
    } catch (e) {
      await client.query("ROLLBACK");
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    } finally {
      client.release();
    }
  }

  const VARIANTS: Array<[string, string]> = [
    ["norestrict", ""],
    ["setnull", "REFERENCES __USERS__(id) ON DELETE SET NULL"],
    ["cascade", "REFERENCES __USERS__(id) ON DELETE CASCADE"],
    ["restrict", "REFERENCES __USERS__(id) ON DELETE RESTRICT"],
  ];

  for (const [label, fk] of VARIANTS) {
    describe(`created_by FK: ${label}`, () => {
      it("the removal itself succeeds", async () => {
        const { users, invites } = await seed(fk, label);
        const r = await removeMember(users, invites);
        assert.equal(r.ok, true, `removal failed under ${label}: ${(r as { error?: string }).error}`);
      });

      it("the member's UNUSED code is no longer redeemable", async () => {
        const { users, invites } = await seed(fk, label);
        await removeMember(users, invites);
        const { rows } = await pool.query(`SELECT token FROM ${invites} WHERE token = 'LIVE-AAAA'`);
        assert.equal(rows.length, 0, "a removed member's live invite code survived");
      });

      it("the USED code survives as an audit record", async () => {
        const { users, invites } = await seed(fk, label);
        await removeMember(users, invites);
        const { rows } = await pool.query(`SELECT token, used_at FROM ${invites} WHERE token = 'USED-AAAA'`);
        // CASCADE is the one variant that legitimately takes it: the database
        // itself removes rows pointing at the deleted user, and that is the
        // schema's decision, not ours.
        if (label === "cascade") {
          assert.equal(rows.length, 0, "cascade should have removed it");
        } else {
          assert.equal(rows.length, 1, "the audit record of a completed join was destroyed");
          assert.notEqual(rows[0].used_at, null);
        }
      });
    });
  }

  // The visibility half of F6, as a straight differential.
  describe("an orphaned invite stays visible to the owner", () => {
    it("INNER JOIN drops it; LEFT JOIN keeps it", async () => {
      const { users, invites } = await seed("", "orphan");
      // Simulate the pre-existing orphans already in production: a live code
      // whose creator's users row is gone, left behind by a past removal.
      await pool.query(`DELETE FROM ${users} WHERE id = $1`, [MEMBER]);

      const inner = await pool.query(
        `SELECT ci.token FROM ${invites} ci
           JOIN ${users} u ON u.id = ci.created_by
          WHERE ci.company_id = $1 AND ci.used_at IS NULL`,
        [COMPANY]
      );
      const left = await pool.query(
        `SELECT ci.token, u.display_name AS created_by_name FROM ${invites} ci
           LEFT JOIN ${users} u ON u.id = ci.created_by
          WHERE ci.company_id = $1 AND ci.used_at IS NULL`,
        [COMPANY]
      );

      assert.equal(inner.rows.length, 0, "inner join was expected to hide the orphan — that was the bug");
      assert.equal(left.rows.length, 1, "left join must surface the orphan so it can be revoked");
      assert.equal(left.rows[0].token, "LIVE-AAAA");
      assert.equal(left.rows[0].created_by_name, null, "the missing name must be null, not a lost row");
    });
  });
});
