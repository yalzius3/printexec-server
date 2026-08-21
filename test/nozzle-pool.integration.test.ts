// Integration tests for the nozzle-pool statements. These EXECUTE the exact SQL
// jobs.service.ts sends (imported from src/jobs/nozzle-pool.ts — not a copy)
// against a real Postgres.
//
// WHY THESE EXIST. The auto-substitution decides which physical nozzle a print
// runs on. Everything about it had been type-checked and reasoned about and
// none of the SQL had ever executed: a CTE referenced twice, a LEFT JOIN over a
// UNION, a conditional half that must appear only when print_beds does, and a
// parameter list whose length changes with it. Postgres rejects a bind that
// supplies more parameters than the statement uses, so the `hasBeds` variants
// are two different statements and both have to be right. A mistake there is
// not a wrong answer — it is a 500 on every drop.
//
// They also pin the BEHAVIOUR the board depends on: an unbooked nozzle must
// still come back (as a row with null bounds), because that row is the free
// twin the whole feature turns on.
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
import pg from "pg";
// The production statements, imported so the test cannot drift from them.
import {
  foldNozzlePools,
  nozzleBusyProbeSql,
  nozzlePoolSql,
  nozzleRosterSql,
  poolBusyIntervals,
  type NozzlePoolRow,
} from "../src/jobs/nozzle-pool.ts";
import { chooseInterchangeableNozzle, nozzleSpecOf } from "../src/simple-jobs/packing.ts";

const { Pool } = pg;

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const isLocal = !!TEST_DB_URL && /localhost|127\.0\.0\.1|::1/.test(TEST_DB_URL);
const SCHEMA = `nozzle_pool_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const T0 = Date.UTC(2026, 7, 21, 9, 0, 0);
const H = 3_600_000;
const at = (h: number) => new Date(T0 + h * H).toISOString();

describe(
  "nozzle pools (integration)",
  { skip: TEST_DB_URL ? false : "set TEST_DATABASE_URL to run" },
  () => {
    let pool: InstanceType<typeof Pool>;
    let companyId: string;
    let otherCompanyId: string;
    let printerId: string;
    let otherPrinterId: string;
    // Three interchangeable 0.4mm brass nozzles, one 0.4mm hardened, one damaged.
    let nzA: string;
    let nzB: string;
    let nzC: string;
    let nzHardened: string;
    let nzDamaged: string;

    before(async () => {
      pool = new Pool({
        connectionString: TEST_DB_URL,
        max: 4,
        ssl: isLocal ? false : { rejectUnauthorized: false },
      });
      await pool.query(`CREATE SCHEMA "${SCHEMA}"`);
      // Every statement in nozzle-pool.ts is unqualified, so search_path is what
      // points them at the throwaway schema.
      await pool.query(`SET search_path TO "${SCHEMA}"`);
      pool.on("connect", (client) => {
        void client.query(`SET search_path TO "${SCHEMA}"`);
      });

      // Only the columns these statements touch. Deliberately NOT the full
      // production schema: a narrower table proves the statements name nothing
      // they were not supposed to, and anything extra they reach for fails here
      // loudly rather than in production quietly.
      await pool.query(`
        CREATE TABLE printer_instances (
          printer_id uuid PRIMARY KEY,
          company_id uuid NOT NULL,
          brand text,
          model text
        );
        CREATE TABLE asset_instances (
          asset_id uuid PRIMARY KEY,
          company_id uuid NOT NULL,
          nozzle_diameter_mm numeric,
          nozzle_material text,
          nozzle_name text,
          nozzle_brand text,
          location text
        );
        CREATE TABLE asset_stock (
          asset_id uuid PRIMARY KEY,
          status text,
          installed_on_asset_id uuid
        );
        CREATE TABLE printer_nozzle_compatibility (
          company_id uuid NOT NULL,
          printer_id uuid NOT NULL,
          nozzle_asset_id uuid NOT NULL,
          PRIMARY KEY (company_id, printer_id, nozzle_asset_id)
        );
        CREATE TABLE order_pieces (
          piece_id uuid PRIMARY KEY,
          company_id uuid NOT NULL,
          piece_name text,
          assigned_nozzle_asset_id uuid,
          status text,
          scheduled_start_at timestamptz,
          scheduled_end_at timestamptz
        );
        CREATE TABLE print_beds (
          bed_id uuid PRIMARY KEY,
          company_id uuid NOT NULL,
          bed_name text,
          assigned_nozzle_asset_id uuid,
          status text,
          scheduled_start_at timestamptz,
          scheduled_end_at timestamptz
        );
      `);

      companyId = randomUUID();
      otherCompanyId = randomUUID();
      printerId = randomUUID();
      otherPrinterId = randomUUID();
      nzA = randomUUID();
      nzB = randomUUID();
      nzC = randomUUID();
      nzHardened = randomUUID();
      nzDamaged = randomUUID();

      await pool.query(
        `INSERT INTO printer_instances (printer_id, company_id, brand, model)
         VALUES ($1,$3,'Bambu','X1C'), ($2,$3,'Prusa','MK4')`,
        [printerId, otherPrinterId, companyId]
      );
      const nozzles: Array<[string, number, string, string | null]> = [
        [nzA, 0.4, "brass", "Bin 1"],
        [nzB, 0.4, "brass", "Bin 2"],
        [nzC, 0.4, "brass", null],
        [nzHardened, 0.4, "hardened", null],
        [nzDamaged, 0.4, "brass", null],
      ];
      for (const [id, dia, mat, loc] of nozzles) {
        await pool.query(
          `INSERT INTO asset_instances (asset_id, company_id, nozzle_diameter_mm, nozzle_material, location)
           VALUES ($1,$2,$3,$4,$5)`,
          [id, companyId, dia, mat, loc]
        );
        await pool.query(
          `INSERT INTO printer_nozzle_compatibility (company_id, printer_id, nozzle_asset_id)
           VALUES ($1,$2,$3)`,
          [companyId, printerId, id]
        );
      }
      // C sits on the OTHER printer — usable, but someone has to carry it.
      await pool.query(
        `INSERT INTO asset_stock (asset_id, status, installed_on_asset_id) VALUES
           ($1,'installed',$5), ($2,'available',NULL), ($3,'available',$6), ($4,'damaged',NULL)`,
        [nzA, nzB, nzC, nzDamaged, printerId, otherPrinterId]
      );
      // nzHardened deliberately has NO asset_stock row — the LEFT JOIN and its
      // COALESCE(status,'available') are what keep it in the roster.
    });

    after(async () => {
      if (!pool) return;
      await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await pool.end();
    });

    const bookPiece = (nozzle: string, name: string, from: number, to: number, status = "scheduled") =>
      pool.query(
        `INSERT INTO order_pieces
           (piece_id, company_id, piece_name, assigned_nozzle_asset_id, status, scheduled_start_at, scheduled_end_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING piece_id`,
        [randomUUID(), companyId, name, nozzle, status, at(from), at(to)]
      );
    const bookBed = (nozzle: string, name: string, from: number, to: number) =>
      pool.query(
        `INSERT INTO print_beds
           (bed_id, company_id, bed_name, assigned_nozzle_asset_id, status, scheduled_start_at, scheduled_end_at)
         VALUES ($1,$2,$3,$4,'scheduled',$5,$6) RETURNING bed_id`,
        [randomUUID(), companyId, name, nozzle, at(from), at(to)]
      );
    const clearBookings = async () => {
      await pool.query(`DELETE FROM order_pieces`);
      await pool.query(`DELETE FROM print_beds`);
    };
    const pools = async (hasBeds: boolean) => {
      const r = await pool.query<NozzlePoolRow>(nozzlePoolSql(hasBeds), [
        companyId, printerId, at(0), at(24),
      ]);
      return foldNozzlePools(r.rows, nozzleSpecOf);
    };

    // ── The statements execute at all ──────────────────────────────────────

    it("every statement runs, in both the beds and no-beds variant", async () => {
      // THE ONE THAT MATTERS MOST. A syntax error or a stray parameter here is
      // a 500 on every drop, and nothing before this point could have caught it.
      for (const hasBeds of [true, false]) {
        await pool.query(nozzlePoolSql(hasBeds), [companyId, printerId, at(0), at(24)]);

        const probeParams: unknown[] = [companyId, nzA, at(0), at(24), null];
        if (hasBeds) probeParams.push(null);
        await pool.query(nozzleBusyProbeSql(hasBeds), probeParams);

        const rosterParams: unknown[] = [companyId, printerId, at(0), at(24), null];
        if (hasBeds) rosterParams.push(null);
        await pool.query(nozzleRosterSql(hasBeds), rosterParams);
      }
    });

    it("the exclusion parameters accept a real id as well as null", async () => {
      const { rows } = await bookPiece(nzA, "Bracket", 2, 4);
      const pieceId = rows[0]!.piece_id;
      const bedRes = await bookBed(nzA, "Plate 7", 6, 8);
      const bedId = bedRes.rows[0]!.bed_id;
      await pool.query(nozzleBusyProbeSql(true), [companyId, nzA, at(0), at(24), pieceId, bedId]);
      await pool.query(nozzleRosterSql(true), [companyId, printerId, at(0), at(24), pieceId, bedId]);
      await clearBookings();
    });

    // ── The pool query ─────────────────────────────────────────────────────

    it("groups the printer's nozzles by spec and drops the damaged one", async () => {
      const out = await pools(true);
      const brass = out.find((p) => p.spec === nozzleSpecOf(0.4, "brass"));
      const hardened = out.find((p) => p.spec === nozzleSpecOf(0.4, "hardened"));
      assert.ok(brass, "expected a 0.4mm brass pool");
      assert.ok(hardened, "expected a 0.4mm hardened pool");
      assert.deepEqual(
        brass.members.map((m) => m.nozzle_asset_id).sort(),
        [nzA, nzB, nzC].sort(),
        "the damaged nozzle must not be offered as a stand-in",
      );
      // No asset_stock row at all still counts as usable.
      assert.equal(hardened.members.length, 1);
    });

    it("a nozzle with nothing booked comes back as a member with no blocks", async () => {
      // The free twin. If the LEFT JOIN ever became an inner one this vanishes,
      // and with it the entire feature — silently.
      const out = await pools(true);
      const brass = out.find((p) => p.spec === nozzleSpecOf(0.4, "brass"))!;
      assert.equal(brass.members.length, 3);
      for (const m of brass.members) assert.deepEqual(m.busy, []);
    });

    it("reports where a nozzle is fitted, so a move can be flagged", async () => {
      const brass = (await pools(true)).find((p) => p.spec === nozzleSpecOf(0.4, "brass"))!;
      const byId = new Map(brass.members.map((m) => [m.nozzle_asset_id, m]));
      assert.equal(byId.get(nzA)!.installed_on_printer_id, printerId);
      assert.equal(byId.get(nzB)!.installed_on_printer_id, null);
      assert.equal(byId.get(nzC)!.installed_on_printer_id, otherPrinterId);
    });

    it("counts BOTH pieces and beds against a nozzle", async () => {
      await bookPiece(nzA, "Bracket", 2, 4);
      await bookBed(nzB, "Plate 7", 5, 9);
      const brass = (await pools(true)).find((p) => p.spec === nozzleSpecOf(0.4, "brass"))!;
      const byId = new Map(brass.members.map((m) => [m.nozzle_asset_id, m]));
      assert.equal(byId.get(nzA)!.busy.length, 1);
      assert.equal(byId.get(nzB)!.busy.length, 1, "a bed holds a nozzle exactly as a piece does");
      assert.equal(byId.get(nzC)!.busy.length, 0);
      await clearBookings();
    });

    it("without print_beds, the piece half alone is still correct", async () => {
      await bookPiece(nzA, "Bracket", 2, 4);
      await bookBed(nzB, "Plate 7", 5, 9);
      const brass = (await pools(false)).find((p) => p.spec === nozzleSpecOf(0.4, "brass"))!;
      const byId = new Map(brass.members.map((m) => [m.nozzle_asset_id, m]));
      assert.equal(byId.get(nzA)!.busy.length, 1);
      assert.equal(byId.get(nzB)!.busy.length, 0, "beds are invisible to the no-beds variant");
      await clearBookings();
    });

    it("ignores blocks outside the window and jobs that are not committed", async () => {
      await bookPiece(nzA, "Yesterday", -10, -8);
      await bookPiece(nzA, "Next week", 200, 202);
      await bookPiece(nzA, "Cancelled", 2, 4, "cancelled");
      await bookPiece(nzA, "Finished", 2, 4, "done");
      const brass = (await pools(true)).find((p) => p.spec === nozzleSpecOf(0.4, "brass"))!;
      const a = brass.members.find((m) => m.nozzle_asset_id === nzA)!;
      assert.deepEqual(a.busy, [], "only scheduled/printing work inside the window holds a nozzle");
      await clearBookings();
    });

    it("counts a print that is already running", async () => {
      await bookPiece(nzA, "Running now", 2, 4, "printing");
      const brass = (await pools(true)).find((p) => p.spec === nozzleSpecOf(0.4, "brass"))!;
      assert.equal(brass.members.find((m) => m.nozzle_asset_id === nzA)!.busy.length, 1);
      await clearBookings();
    });

    it("never leaks another company's bookings or nozzles", async () => {
      await pool.query(
        `INSERT INTO order_pieces
           (piece_id, company_id, piece_name, assigned_nozzle_asset_id, status, scheduled_start_at, scheduled_end_at)
         VALUES ($1,$2,'Someone else',$3,'scheduled',$4,$5)`,
        [randomUUID(), otherCompanyId, nzA, at(2), at(4)]
      );
      const brass = (await pools(true)).find((p) => p.spec === nozzleSpecOf(0.4, "brass"))!;
      assert.deepEqual(brass.members.find((m) => m.nozzle_asset_id === nzA)!.busy, []);
      const empty = await pool.query(nozzlePoolSql(true), [otherCompanyId, printerId, at(0), at(24)]);
      assert.equal(empty.rowCount, 0, "another company sees none of this printer's roster");
      await clearBookings();
    });

    // ── End to end: the board's answer and the server's must agree ─────────

    it("a busy nozzle does NOT block the pool while a twin is free", async () => {
      // The reported bug, end to end. A is booked 2-4; B and C are idle.
      await bookPiece(nzA, "Bracket", 2, 4);
      const brass = (await pools(true)).find((p) => p.spec === nozzleSpecOf(0.4, "brass"))!;

      // What the BOARD computes when placing a chip at 02:00.
      assert.deepEqual(poolBusyIntervals(brass.members), [], "the board must offer the slot");

      // What the SERVER does when the chip is committed there.
      const rosterParams: unknown[] = [companyId, printerId, at(2), at(4), null];
      rosterParams.push(null);
      const roster = await pool.query(nozzleRosterSql(true), rosterParams);
      const busyById = new Map(roster.rows.map((r) => [r.nozzle_asset_id, r.busy as boolean]));
      const substitute = chooseInterchangeableNozzle({
        assignedId: nzA,
        assignedDiameterMm: 0.4,
        assignedMaterial: "brass",
        printerId,
        options: roster.rows.map((r) => ({
          nozzle_asset_id: r.nozzle_asset_id,
          nozzle_diameter_mm: r.nozzle_diameter_mm != null ? Number(r.nozzle_diameter_mm) : null,
          nozzle_material: r.nozzle_material,
          status: r.status,
          installed_on: r.installed_on,
          label: "",
        })),
        isFree: (id) => busyById.get(id) === false,
      });
      assert.equal(substitute?.nozzle_asset_id, nzB, "B is idle; C would mean walking to another printer");
      await clearBookings();
    });

    it("when every twin is busy, board and server both say no", async () => {
      await bookPiece(nzA, "Bracket", 2, 6);
      await bookPiece(nzB, "Housing", 1, 5);
      await bookBed(nzC, "Plate 7", 0, 8);
      const brass = (await pools(true)).find((p) => p.spec === nozzleSpecOf(0.4, "brass"))!;

      const blocked = poolBusyIntervals(brass.members);
      assert.equal(blocked.length, 1);
      assert.deepEqual(
        [new Date(blocked[0]!.start).toISOString(), new Date(blocked[0]!.end).toISOString()],
        [at(2), at(5)],
        "blocked exactly where all three overlap",
      );

      const probe = await pool.query(nozzleBusyProbeSql(true), [companyId, nzA, at(3), at(4), null, null]);
      assert.equal(probe.rows[0]?.label, "Bracket", "the refusal can name what is in the way");
      await clearBookings();
    });

    it("a piece dragged within its own window is not blocked by itself", async () => {
      // A carries the dragged piece (2-4) AND an unrelated job (6-8); B and C
      // are booked solid. So the pool looks full in both of A's windows, and
      // discounting the dragged piece must reopen ONLY its own.
      const mine = await bookPiece(nzA, "Bracket", 2, 4);
      const pieceId = mine.rows[0]!.piece_id;
      await bookPiece(nzA, "Someone else's", 6, 8);
      await bookPiece(nzB, "Housing", 0, 24);
      await bookBed(nzC, "Plate 7", 0, 24);
      const brass = (await pools(true)).find((p) => p.spec === nozzleSpecOf(0.4, "brass"))!;

      const asIs = (refs?: Set<string>) =>
        poolBusyIntervals(brass.members, refs).map((iv) => [
          new Date(iv.start).toISOString(), new Date(iv.end).toISOString(),
        ]);
      assert.deepEqual(asIs(), [[at(2), at(4)], [at(6), at(8)]], "both of A's windows saturate the pool");
      assert.deepEqual(
        asIs(new Set([pieceId])),
        [[at(6), at(8)]],
        "discounting its own block reopens that window and nothing else",
      );

      const probe = await pool.query(nozzleBusyProbeSql(true), [companyId, nzA, at(2), at(4), pieceId, null]);
      assert.equal(probe.rowCount, 0, "the server does not count the piece against itself either");
      await clearBookings();
    });

    it("a piece whose ONLY twin-blocking job is its own frees the pool entirely", async () => {
      // The companion case, and the one that makes a drag onto its own slot
      // work at all: with its own block discounted, A holds nothing, so the
      // pool is free all day however busy the others are.
      const mine = await bookPiece(nzA, "Bracket", 2, 4);
      await bookPiece(nzB, "Housing", 0, 24);
      await bookBed(nzC, "Plate 7", 0, 24);
      const brass = (await pools(true)).find((p) => p.spec === nozzleSpecOf(0.4, "brass"))!;
      assert.equal(poolBusyIntervals(brass.members).length, 1);
      assert.deepEqual(poolBusyIntervals(brass.members, new Set([mine.rows[0]!.piece_id])), []);
      await clearBookings();
    });
  }
);
