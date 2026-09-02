// Integration tests for the BED LIFECYCLE cascade, against a real Postgres.
//
// WHY THESE EXIST. The rule "a plate whose pieces are all gone goes with them,
// a plate that loses only some of them is dismantled" was already written and
// already wired into all five delete paths — and it still leaked, because the
// dismantle branch DETACHES every piece. `order_pieces.bed_id` is the only
// reference to a bed that exists anywhere in the schema, so severing it left
// the plate unreachable by the very function that would later delete it.
// Deleting the remaining pieces afterwards could no longer see the plate they
// used to sit on, and the row stood for good. Seventeen of them had piled up in
// production. That sequence — delete some, then delete the rest — is the first
// thing pinned below, because reasoning about it is exactly what missed it.
//
// The second thing pinned is the CHECK-constraint trap, restated here because
// it bit this codebase again in the same shape. Every status constraint on
// order_pieces carries an `OR bed_id IS NOT NULL` escape; the dismantle revokes
// that escape on the same line that clears bed_id. A piece kept at 'done' with
// no print_completed_at therefore violated chk_done_requires_completed_at and
// took the whole delete down with a bare 500. Production had 60 such pieces
// when this was written, so this was not hypothetical.
//
// The constraints below are copied from the LIVE database (GET
// /api/health/schema dumps every check on order_pieces and print_beds), not
// from the migrations — chk_done_requires_completed_at and
// chk_printing_requires_started_at predate the migrations directory and no file
// in this repository owns them. A test schema built from migrations alone does
// not have them, which is precisely how the last one was missed.
//
// SAFETY: requires a *dedicated* database and is skipped unless
// TEST_DATABASE_URL is set. It deliberately does NOT fall back to DATABASE_URL,
// so it can never run against production. Everything happens in a throwaway
// schema that is dropped on teardown.
//
// Run:  npm run test:integration      (spins up an embedded Postgres)

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
// The production functions — imported, not re-implemented, so what this test
// exercises is what the services actually run. cascade.ts is kept free of Nest
// decorators and constructor parameter properties precisely so that `node
// --test`'s strip-only TypeScript can load it; see storage-keys.ts's header.
import {
  reevaluateBedAfterPieceRemoval,
  deleteEmptyBedTx,
} from "../src/common/cascade.ts";

const { Pool } = pg;

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const isLocal = !!TEST_DB_URL && /localhost|127\.0\.0\.1|::1/.test(TEST_DB_URL);
const SCHEMA = `bed_lifecycle_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

describe(
  "bed lifecycle cascade (integration)",
  { skip: TEST_DB_URL ? false : "set TEST_DATABASE_URL to run" },
  () => {
    let pool: InstanceType<typeof Pool>;
    let companyId: string;

    before(async () => {
      pool = new Pool({
        connectionString: TEST_DB_URL,
        max: 4,
        ssl: isLocal ? false : { rejectUnauthorized: false },
      });
      await pool.query(`CREATE SCHEMA "${SCHEMA}"`);
      await pool.query(`SET search_path TO "${SCHEMA}"`);
      pool.on("connect", (client) => {
        void client.query(`SET search_path TO "${SCHEMA}"`);
      });

      await pool.query(`
        CREATE TABLE orders (
          order_id uuid PRIMARY KEY,
          company_id uuid NOT NULL,
          order_number text NOT NULL
        );

        CREATE TABLE order_pieces (
          piece_id uuid PRIMARY KEY,
          company_id uuid NOT NULL,
          order_id uuid NOT NULL REFERENCES orders(order_id),
          piece_name text NOT NULL,
          status text NOT NULL,
          bed_id uuid,
          assigned_printer_id uuid,
          assigned_nozzle_asset_id uuid,
          required_print_technology text,
          resin_tank_id uuid,
          slicer_print_time_minutes int,
          slicer_filament_used_grams numeric,
          slicer_resin_used_ml numeric,
          scheduled_start_at timestamptz,
          scheduled_end_at timestamptz,
          scheduled_at timestamptz,
          print_started_at timestamptz,
          print_completed_at timestamptz,

          -- Copied verbatim in shape from the live database. The escape hatch
          -- is the load-bearing part of each one.
          CONSTRAINT chk_assigned_requires_printer CHECK (
            status <> 'assigned' OR bed_id IS NOT NULL OR assigned_printer_id IS NOT NULL
          ),
          CONSTRAINT chk_done_requires_completed_at CHECK (
            status <> 'done' OR bed_id IS NOT NULL OR print_completed_at IS NOT NULL
          ),
          CONSTRAINT chk_printing_requires_started_at CHECK (
            status <> 'printing' OR bed_id IS NOT NULL OR print_started_at IS NOT NULL
          )
        );

        CREATE TABLE print_beds (
          bed_id uuid PRIMARY KEY,
          company_id uuid NOT NULL,
          bed_name text NOT NULL,
          status text NOT NULL,
          assigned_printer_id uuid,
          assigned_nozzle_asset_id uuid,
          slicer_file_url text,
          stl_file_url text,
          scheduled_start_at timestamptz,
          scheduled_end_at timestamptz,
          scheduled_at timestamptz,
          print_started_at timestamptz,
          print_completed_at timestamptz,
          actual_print_time_minutes int
        );
      `);

      companyId = randomUUID();
    });

    after(async () => {
      if (!pool) return;
      await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await pool.end();
    });

    beforeEach(async () => {
      await pool.query(`TRUNCATE order_pieces, print_beds, orders CASCADE`);
    });

    // ── fixture helpers ──────────────────────────────────────────────────
    async function makeOrder(): Promise<string> {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO orders (order_id, company_id, order_number) VALUES ($1,$2,$3)`,
        [id, companyId, `ORD-${id.slice(0, 8)}`]
      );
      return id;
    }

    async function makeBed(opts: { ran?: boolean; files?: boolean } = {}): Promise<string> {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO print_beds (bed_id, company_id, bed_name, status,
                                 assigned_printer_id, print_started_at,
                                 print_completed_at, slicer_file_url, stl_file_url)
         VALUES ($1,$2,$3,'assigned',$4,$5,$6,$7,$8)`,
        [
          id,
          companyId,
          `plate-${id.slice(0, 8)}`,
          randomUUID(),
          opts.ran ? new Date(Date.now() - 7200_000) : null,
          opts.ran ? new Date(Date.now() - 3600_000) : null,
          opts.files ? `/api/uploads/${companyId}/plate.gcode` : null,
          opts.files ? `/api/uploads/${companyId}/plate.stl` : null,
        ]
      );
      return id;
    }

    async function makePiece(
      orderId: string,
      bedId: string | null,
      status = "pending",
      extra: { print_completed_at?: Date | null; print_started_at?: Date | null } = {}
    ): Promise<string> {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO order_pieces (piece_id, company_id, order_id, piece_name,
                                   status, bed_id, print_started_at, print_completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, companyId, orderId, `p-${id.slice(0, 8)}`, status, bedId,
         extra.print_started_at ?? null, extra.print_completed_at ?? null]
      );
      return id;
    }

    const bedCount = async (bedId: string) =>
      Number((await pool.query(`SELECT COUNT(*) c FROM print_beds WHERE bed_id=$1`, [bedId])).rows[0].c);
    const bedStatus = async (bedId: string) =>
      (await pool.query(`SELECT status FROM print_beds WHERE bed_id=$1`, [bedId])).rows[0]?.status ?? null;
    const pieceRow = async (pieceId: string) =>
      (await pool.query(`SELECT * FROM order_pieces WHERE piece_id=$1`, [pieceId])).rows[0];

    /** Run `fn` on a real transaction client, exactly as a service would. */
    async function inTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn(client);
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    }

    // ── 1. The regression this whole change exists for ───────────────────
    it("delete SOME pieces then the REST leaves no orphaned plate behind", async () => {
      const orderA = await makeOrder();
      const orderB = await makeOrder();
      const bedId = await makeBed();
      const a1 = await makePiece(orderA, bedId);
      const b1 = await makePiece(orderB, bedId);
      const b2 = await makePiece(orderB, bedId);

      // Step 1: order A is deleted. Its piece goes; B's two survive.
      await inTx(async (c) => {
        await c.query(`DELETE FROM order_pieces WHERE piece_id=$1`, [a1]);
        await reevaluateBedAfterPieceRemoval(c, companyId, bedId);
      });

      // The plate is gone the moment it is dismantled — this is the fix. Before
      // it, the plate survived as an empty 'disassembled' row that nothing could
      // reach, and step 2 below could never remove it.
      assert.equal(await bedCount(bedId), 0, "dismantled plate should not survive");

      // The survivors are released to standalone 'pending', not deleted.
      for (const id of [b1, b2]) {
        const row = await pieceRow(id);
        assert.equal(row.bed_id, null, "survivor should be detached");
        assert.equal(row.status, "pending", "survivor should return to the pool");
      }

      // Step 2: order B is deleted too. Nothing is left anywhere.
      await inTx(async (c) => {
        await c.query(`DELETE FROM order_pieces WHERE order_id=$1`, [orderB]);
      });
      assert.equal(await bedCount(bedId), 0);
      const orphans = await pool.query(
        `SELECT pb.bed_id FROM print_beds pb
          WHERE NOT EXISTS (SELECT 1 FROM order_pieces op WHERE op.bed_id = pb.bed_id)`
      );
      assert.equal(orphans.rowCount, 0, "no empty plate may remain");
    });

    // ── 2. All pieces deleted → plate deleted, unconditionally ───────────
    it("deletes the plate when every piece is deleted, even one that ran", async () => {
      const order = await makeOrder();
      const bedId = await makeBed({ ran: true, files: true });
      await makePiece(order, bedId, "done", { print_completed_at: new Date() });

      const keys = await inTx(async (c) => {
        await c.query(`DELETE FROM order_pieces WHERE order_id=$1`, [order]);
        return reevaluateBedAfterPieceRemoval(c, companyId, bedId);
      });

      assert.equal(await bedCount(bedId), 0, "plate with no pieces left must go");
      // Its own G-code and STL come back for removal after the commit.
      assert.deepEqual(keys.sort(), [`${companyId}/plate.gcode`, `${companyId}/plate.stl`].sort());
    });

    // ── 3. A plate that RAN survives a dismantle (real history) ──────────
    it("keeps a plate that actually ran when it is dismantled", async () => {
      const orderA = await makeOrder();
      const orderB = await makeOrder();
      const bedId = await makeBed({ ran: true, files: true });
      const a1 = await makePiece(orderA, bedId);
      await makePiece(orderB, bedId);

      const keys = await inTx(async (c) => {
        await c.query(`DELETE FROM order_pieces WHERE piece_id=$1`, [a1]);
        return reevaluateBedAfterPieceRemoval(c, companyId, bedId);
      });

      assert.equal(await bedCount(bedId), 1, "a plate that printed keeps its record");
      assert.equal(await bedStatus(bedId), "disassembled");
      assert.deepEqual(keys, [], "its files are still referenced by the surviving row");
    });

    // ── 4. THE CHECK-CONSTRAINT TRAP, in both directions ─────────────────
    it("carries the plate's completion stamp out with a 'done' piece", async () => {
      const orderA = await makeOrder();
      const orderB = await makeOrder();
      const bedId = await makeBed({ ran: true });
      const a1 = await makePiece(orderA, bedId);
      // The production shape: 'done' on a plate with NO completion stamp of its
      // own. Legal only while bed_id is set; the dismantle revokes that escape.
      const done = await makePiece(orderB, bedId, "done", { print_completed_at: null });

      await inTx(async (c) => {
        await c.query(`DELETE FROM order_pieces WHERE piece_id=$1`, [a1]);
        await reevaluateBedAfterPieceRemoval(c, companyId, bedId);
      });

      const row = await pieceRow(done);
      assert.equal(row.bed_id, null, "the piece detached");
      assert.equal(row.status, "done", "a finished part stays finished");
      assert.notEqual(row.print_completed_at, null,
        "it must carry a completion stamp out, or the CHECK fails and the whole delete 500s");
      assert.ok(row.print_completed_at.getTime() <= Date.now() + 1000,
        "the stamp is clamped to now() — a part cannot finish in the future");
    });

    it("carries a start stamp out with a 'printing' piece", async () => {
      const orderA = await makeOrder();
      const orderB = await makeOrder();
      const bedId = await makeBed();
      const a1 = await makePiece(orderA, bedId);
      const printing = await makePiece(orderB, bedId, "printing", { print_started_at: null });

      await inTx(async (c) => {
        await c.query(`DELETE FROM order_pieces WHERE piece_id=$1`, [a1]);
        await reevaluateBedAfterPieceRemoval(c, companyId, bedId);
      });

      const row = await pieceRow(printing);
      assert.equal(row.status, "printing");
      assert.equal(row.bed_id, null);
      assert.notEqual(row.print_started_at, null,
        "chk_printing_requires_started_at is revoked by the detach");
    });

    // ── 5. All-cancelled → the plate is cancelled and KEPT ───────────────
    it("cancels (does not delete) a plate whose remaining pieces are all cancelled", async () => {
      const orderA = await makeOrder();
      const orderB = await makeOrder();
      const bedId = await makeBed();
      const a1 = await makePiece(orderA, bedId);
      const c1 = await makePiece(orderB, bedId, "cancelled");

      const keys = await inTx(async (c) => {
        await c.query(`DELETE FROM order_pieces WHERE piece_id=$1`, [a1]);
        return reevaluateBedAfterPieceRemoval(c, companyId, bedId);
      });

      assert.equal(await bedCount(bedId), 1);
      assert.equal(await bedStatus(bedId), "cancelled");
      assert.deepEqual(keys, []);
      // Cancelled pieces stay ON the plate — the arrangement is intact.
      assert.equal((await pieceRow(c1)).bed_id, bedId);
    });

    // ── 6. The guard fails CLOSED ────────────────────────────────────────
    it("refuses to delete a plate that still holds pieces", async () => {
      const order = await makeOrder();
      const bedId = await makeBed();
      await makePiece(order, bedId);

      // Both flavours must decline: emptiness is re-tested inside the statement,
      // so a mistaken call cannot remove a populated plate.
      for (const keepIfItRan of [true, false]) {
        const res = await inTx((c) =>
          deleteEmptyBedTx(c, companyId, bedId, { keepIfItRan })
        );
        assert.equal(res.deleted, false, `keepIfItRan=${keepIfItRan} must not delete a populated plate`);
        assert.deepEqual(res.keys, []);
      }
      assert.equal(await bedCount(bedId), 1);
    });

    it("never touches another company's plate", async () => {
      const other = randomUUID();
      const order = await makeOrder();
      const bedId = await makeBed();
      await makePiece(order, bedId);
      await pool.query(`DELETE FROM order_pieces WHERE bed_id=$1`, [bedId]);

      const res = await inTx((c) => deleteEmptyBedTx(c, other, bedId, { keepIfItRan: false }));
      assert.equal(res.deleted, false, "company scoping must hold");
      assert.equal(await bedCount(bedId), 1);
    });

    // ── 7. A rolled-back transaction removes no bytes ────────────────────
    it("deletes nothing when the transaction rolls back", async () => {
      const order = await makeOrder();
      const bedId = await makeBed({ files: true });
      await makePiece(order, bedId);

      await assert.rejects(
        inTx(async (c) => {
          await c.query(`DELETE FROM order_pieces WHERE order_id=$1`, [order]);
          await reevaluateBedAfterPieceRemoval(c, companyId, bedId);
          throw new Error("caller failed after the cascade");
        }),
        /caller failed after the cascade/
      );

      // The plate is still standing — which is exactly why the keys are returned
      // for removal AFTER the commit rather than deleted inside the transaction.
      assert.equal(await bedCount(bedId), 1, "a rolled-back cascade must leave the plate");
    });
  }
);
