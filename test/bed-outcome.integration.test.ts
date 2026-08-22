// Integration tests for the bed-outcome WRITE path, against a real Postgres.
//
// WHY THESE EXIST. test/bed-outcome.test.ts proves the arithmetic; nothing in it
// touches SQL. The statements that spend that arithmetic are the part a
// type-checker is blind to — a template literal is just a string to `tsc`, and
// two of these statements are UNNEST inserts whose parameter arrays have to line
// up positionally with a column list. A transposed pair there would write every
// piece's waste against the wrong order, silently, and the first evidence would
// be a customer's invoice.
//
// The other half is the CHECK-constraint trap, and it is the reason this file
// exists at all rather than a VERIFY script nobody runs. A piece packed on a
// plate is allowed to sit in any status with no printer and no slicer data,
// because every one of those constraints carries an `OR bed_id IS NOT NULL`
// escape. Triaging the plate CLEARS bed_id — which revokes that escape on the
// very same statement. A re-queue to 'assigned' that forgets to carry the
// plate's printer out with the piece is therefore not a validation message, it
// is a constraint violation surfacing as a bare 500 on a shop floor mid-shift.
// That specific shape has bitten this codebase before (see the resin readiness
// work), so it is pinned here in both directions.
//
// SAFETY: requires a *dedicated* database and is skipped unless
// TEST_DATABASE_URL is set. It deliberately does NOT fall back to DATABASE_URL,
// so it can never run against production. Everything happens in a throwaway
// schema that is dropped on teardown.
//
// Run:  npm run test:integration      (spins up an embedded Postgres)

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
// The production kernel — imported, not re-implemented, so the numbers this
// test writes are the numbers the service would write.
import { settlePlate, splitAcrossSpools, requeueStatus } from "../src/beds/outcome.ts";

const { Pool } = pg;

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const isLocal = !!TEST_DB_URL && /localhost|127\.0\.0\.1|::1/.test(TEST_DB_URL);
const SCHEMA = `bed_outcome_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

describe(
  "bed outcome (integration)",
  { skip: TEST_DB_URL ? false : "set TEST_DATABASE_URL to run" },
  () => {
    let pool: InstanceType<typeof Pool>;
    let companyId: string;
    let printerId: string;

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

      // A faithful subset of the real schema: the columns these statements
      // touch, and — the part that matters — the status CHECK constraints
      // copied from the migrations that own them, INCLUDING the bed_id escape
      // hatch (2026-07-01_readiness_bed_escape_fix.sql, re-stated per technology
      // in 2026-07-27_resin_tech.sql). Without those constraints this test would
      // happily accept the write that production rejects.
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
          cost_inputs jsonb,
          required_print_technology text,
          assigned_printer_id uuid,
          assigned_nozzle_asset_id uuid,
          resin_tank_id uuid,
          scheduled_start_at timestamptz,
          scheduled_end_at timestamptz,
          scheduled_at timestamptz,
          slicer_file_url text,
          slicer_file_uploaded_at timestamptz,
          slicer_print_time_minutes int,
          slicer_filament_used_grams numeric,
          slicer_resin_used_ml numeric,
          fulfilment_status text NOT NULL DEFAULT 'none',
          post_process_state text,
          post_process_state_entered_at timestamptz,

          CONSTRAINT chk_assigned_requires_printer CHECK (
            status <> 'assigned'
            OR bed_id IS NOT NULL
            OR assigned_printer_id IS NOT NULL
          ),
          CONSTRAINT chk_ready_requires_core_data CHECK (
            status <> 'ready'
            OR bed_id IS NOT NULL
            OR (
              CASE WHEN required_print_technology IN ('MSLA', 'SLA') THEN
                assigned_printer_id IS NOT NULL
                AND slicer_print_time_minutes IS NOT NULL
                AND slicer_resin_used_ml IS NOT NULL
                AND resin_tank_id IS NOT NULL
              ELSE
                assigned_printer_id IS NOT NULL
                AND assigned_nozzle_asset_id IS NOT NULL
                AND slicer_print_time_minutes IS NOT NULL
                AND slicer_filament_used_grams IS NOT NULL
              END
            )
          ),
          CONSTRAINT chk_scheduled_requires_core_data CHECK (
            status <> ALL (ARRAY['scheduled'::text, 'printing'::text])
            OR bed_id IS NOT NULL
            OR (
              CASE WHEN required_print_technology IN ('MSLA', 'SLA') THEN
                assigned_printer_id IS NOT NULL
                AND slicer_print_time_minutes IS NOT NULL
                AND slicer_resin_used_ml IS NOT NULL
                AND resin_tank_id IS NOT NULL
              ELSE
                assigned_printer_id IS NOT NULL
                AND assigned_nozzle_asset_id IS NOT NULL
                AND slicer_print_time_minutes IS NOT NULL
                AND slicer_filament_used_grams IS NOT NULL
              END
            )
          )
        );

        CREATE TABLE print_beds (
          bed_id uuid PRIMARY KEY,
          company_id uuid NOT NULL,
          bed_name text NOT NULL,
          status text NOT NULL,
          required_print_technology text NOT NULL,
          assigned_printer_id uuid,
          assigned_nozzle_asset_id uuid,
          resin_tank_id uuid,
          slicer_filament_used_grams numeric,
          slicer_resin_used_ml numeric,
          scheduled_start_at timestamptz,
          scheduled_end_at timestamptz,
          scheduled_at timestamptz,
          print_started_at timestamptz,
          print_completed_at timestamptz,
          actual_print_time_minutes int
        );

        CREATE TABLE order_piece_spools (
          company_id uuid NOT NULL,
          piece_id uuid NOT NULL,
          spool_asset_id uuid NOT NULL,
          planned_grams numeric NOT NULL,
          sequence_order int NOT NULL DEFAULT 1
        );

        CREATE TABLE asset_stock (
          asset_id uuid PRIMARY KEY,
          remaining_grams numeric,
          remaining_volume_ml numeric,
          reserved_grams numeric DEFAULT 0,
          status text NOT NULL DEFAULT 'available'
        );

        CREATE TABLE filament_waste_events (
          waste_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          company_id uuid NOT NULL,
          order_id uuid NOT NULL,
          piece_id uuid,
          spool_asset_id uuid,
          material_type text,
          grams numeric NOT NULL,
          unit_cost_per_gram numeric,
          cost numeric,
          source text NOT NULL DEFAULT 'simple_failed'
            CHECK (source IN ('simple_failed')),
          journal_entry_id uuid,
          created_by uuid,
          unit text NOT NULL DEFAULT 'g',
          created_at timestamptz NOT NULL DEFAULT now()
        );

        CREATE TABLE order_history (
          history_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          company_id uuid NOT NULL,
          entity_type text NOT NULL,
          event_type text NOT NULL,
          order_id uuid,
          order_number text,
          piece_id uuid,
          piece_name text,
          description text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        );
      `);

      companyId = randomUUID();
      printerId = randomUUID();
    });

    after(async () => {
      if (!pool) return;
      await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await pool.end();
    });

    /** A plate of `n` pieces, all bedded and 'printing', each quoted at `grams`. */
    async function makePlate(opts: {
      n: number;
      grams: number;
      tech?: string;
      plateQuantity?: number;
    }): Promise<{ bedId: string; orderId: string; pieceIds: string[] }> {
      const bedId = randomUUID();
      const orderId = randomUUID();
      const tech = opts.tech ?? "FDM";
      await pool.query(`INSERT INTO orders VALUES ($1, $2, $3)`, [
        orderId,
        companyId,
        `ORD-${Math.floor(Math.random() * 1e6)}`,
      ]);
      await pool.query(
        `INSERT INTO print_beds (bed_id, company_id, bed_name, status,
             required_print_technology, assigned_printer_id, assigned_nozzle_asset_id,
             slicer_filament_used_grams, slicer_resin_used_ml)
         VALUES ($1, $2, 'Plate A', 'printing', $3, $4, $5, $6, $7)`,
        [
          bedId,
          companyId,
          tech,
          printerId,
          tech === "FDM" ? randomUUID() : null,
          tech === "FDM" ? (opts.plateQuantity ?? opts.n * opts.grams) : null,
          tech === "FDM" ? null : (opts.plateQuantity ?? opts.n * opts.grams),
        ],
      );
      const pieceIds: string[] = [];
      for (let i = 0; i < opts.n; i += 1) {
        const pieceId = randomUUID();
        pieceIds.push(pieceId);
        await pool.query(
          `INSERT INTO order_pieces
             (piece_id, company_id, order_id, piece_name, status, bed_id,
              cost_inputs, required_print_technology)
           VALUES ($1, $2, $3, $4, 'printing', $5, $6, $7)`,
          [
            pieceId,
            companyId,
            orderId,
            `part-${i}`,
            bedId,
            JSON.stringify({ grams: [String(opts.grams)], time: "30" }),
            tech,
          ],
        );
      }
      return { bedId, orderId, pieceIds };
    }

    // ── The constraint trap ─────────────────────────────────────────────────

    it("a bedded piece may sit in 'printing' with no printer — the bed_id escape", async () => {
      // The premise everything else depends on. If this ever stops being true,
      // the re-queue statements are solving a problem that no longer exists.
      const { pieceIds } = await makePlate({ n: 1, grams: 10 });
      const row = await pool.query(
        `SELECT assigned_printer_id, slicer_filament_used_grams FROM order_pieces WHERE piece_id = $1`,
        [pieceIds[0]],
      );
      assert.equal(row.rows[0].assigned_printer_id, null);
      assert.equal(row.rows[0].slicer_filament_used_grams, null);
    });

    it("detaching a piece to 'assigned' WITHOUT a printer is rejected by the database", async () => {
      // THE ONE THAT MATTERS. This is the bare 500 the service exists to avoid,
      // reproduced deliberately so the guard above it can never be quietly
      // removed as redundant.
      const { pieceIds } = await makePlate({ n: 1, grams: 10 });
      await assert.rejects(
        () =>
          pool.query(
            `UPDATE order_pieces
                SET bed_id = NULL, status = 'assigned', assigned_printer_id = NULL
              WHERE piece_id = $1`,
            [pieceIds[0]],
          ),
        /chk_assigned_requires_printer/,
      );
    });

    it("detaching to 'assigned' WITH the plate's printer is accepted", async () => {
      const { pieceIds } = await makePlate({ n: 1, grams: 10 });
      await pool.query(
        `UPDATE order_pieces
            SET bed_id = NULL, status = 'assigned', assigned_printer_id = $2
          WHERE piece_id = $1`,
        [pieceIds[0], printerId],
      );
      const row = await pool.query(`SELECT status, bed_id FROM order_pieces WHERE piece_id = $1`, [
        pieceIds[0],
      ]);
      assert.equal(row.rows[0].status, "assigned");
      assert.equal(row.rows[0].bed_id, null);
    });

    it("detaching to 'pending' never needs anything — the clean-slate path", async () => {
      const { pieceIds } = await makePlate({ n: 1, grams: 10 });
      await pool.query(
        `UPDATE order_pieces
            SET bed_id = NULL, status = 'pending', assigned_printer_id = NULL,
                assigned_nozzle_asset_id = NULL, resin_tank_id = NULL
          WHERE piece_id = $1`,
        [pieceIds[0]],
      );
      const row = await pool.query(`SELECT status FROM order_pieces WHERE piece_id = $1`, [
        pieceIds[0],
      ]);
      assert.equal(row.rows[0].status, "pending");
    });

    it("detaching to 'done' needs nothing either — a finished part is unconstrained", async () => {
      const { pieceIds } = await makePlate({ n: 1, grams: 10 });
      await pool.query(
        `UPDATE order_pieces SET status = 'done', bed_id = NULL WHERE piece_id = $1`,
        [pieceIds[0]],
      );
      const row = await pool.query(`SELECT status, bed_id FROM order_pieces WHERE piece_id = $1`, [
        pieceIds[0],
      ]);
      assert.deepEqual([row.rows[0].status, row.rows[0].bed_id], ["done", null]);
    });

    it("requeueStatus keeps the service on the accepted side of that constraint", async () => {
      // The kernel's job is to make the rejected statement above unreachable.
      const { pieceIds } = await makePlate({ n: 1, grams: 10 });
      const target = requeueStatus("assigned", null); // plate has no printer
      assert.equal(target, "pending");
      // Which is exactly the statement the database accepts.
      await pool.query(
        `UPDATE order_pieces SET bed_id = NULL, status = $2 WHERE piece_id = $1`,
        [pieceIds[0], target],
      );
    });

    // ── The waste insert ────────────────────────────────────────────────────

    it("the plate-waste UNNEST insert lands every row against its own piece and order", async () => {
      // The positional trap: seven parallel arrays feeding one column list.
      const { orderId, pieceIds } = await makePlate({ n: 3, grams: 100 });
      const spoolA = randomUUID();
      const spoolB = randomUUID();
      const entryId = randomUUID();
      const rows = [
        { orderId, pieceId: pieceIds[0]!, assetId: spoolA, material: "PLA", qty: 12.5, unit: 0.02, cost: 0.25 },
        { orderId, pieceId: pieceIds[1]!, assetId: spoolB, material: "PETG", qty: 7.25, unit: 0.03, cost: 0.2175 },
        // An UNPRICED row: it must still be recorded, but must NOT be attached
        // to the journal entry — the CASE in the statement is what decides that.
        { orderId, pieceId: pieceIds[2]!, assetId: spoolA, material: null, qty: 3, unit: 0, cost: 0 },
      ];

      await pool.query(
        `
        INSERT INTO filament_waste_events
          (company_id, order_id, piece_id, spool_asset_id, material_type,
           grams, unit_cost_per_gram, cost, source, journal_entry_id, created_by, unit)
        SELECT $1, o.order_id, o.piece_id, o.asset_id, o.material_type,
               o.quantity, o.unit_cost, o.cost, 'simple_failed',
               CASE WHEN o.cost > 0 THEN $9::uuid END,
               $10, $11
          FROM UNNEST(
                 $2::uuid[], $3::uuid[], $4::uuid[], $5::text[],
                 $6::numeric[], $7::numeric[], $8::numeric[]
               ) AS o(order_id, piece_id, asset_id, material_type,
                      quantity, unit_cost, cost)
        `,
        [
          companyId,
          rows.map((r) => r.orderId),
          rows.map((r) => r.pieceId),
          rows.map((r) => r.assetId),
          rows.map((r) => r.material),
          rows.map((r) => r.qty),
          rows.map((r) => r.unit),
          rows.map((r) => r.cost),
          entryId,
          null,
          "g",
        ],
      );

      const got = await pool.query(
        `SELECT piece_id, order_id, spool_asset_id, material_type, grams::float8 AS grams,
                cost::float8 AS cost, journal_entry_id, unit, source
           FROM filament_waste_events
          WHERE company_id = $1
          ORDER BY grams DESC`,
        [companyId],
      );
      assert.equal(got.rowCount, 3);

      // Each row against ITS OWN piece — a transposed array would still insert
      // three rows, which is why this asserts the pairing and not the count.
      const byPiece = new Map(got.rows.map((r) => [r.piece_id, r]));
      assert.equal(byPiece.get(pieceIds[0]!)!.spool_asset_id, spoolA);
      assert.equal(byPiece.get(pieceIds[0]!)!.material_type, "PLA");
      assert.equal(byPiece.get(pieceIds[0]!)!.grams, 12.5);
      assert.equal(byPiece.get(pieceIds[1]!)!.spool_asset_id, spoolB);
      assert.equal(byPiece.get(pieceIds[1]!)!.material_type, "PETG");
      assert.equal(byPiece.get(pieceIds[1]!)!.grams, 7.25);

      // Priced rows carry the entry; the unpriced one carries null.
      assert.equal(byPiece.get(pieceIds[0]!)!.journal_entry_id, entryId);
      assert.equal(byPiece.get(pieceIds[1]!)!.journal_entry_id, entryId);
      assert.equal(byPiece.get(pieceIds[2]!)!.journal_entry_id, null);

      // And the source stays inside the CHECK the column already ships with —
      // this feature must not need a migration to record a loss.
      for (const r of got.rows) assert.equal(r.source, "simple_failed");
      for (const r of got.rows) assert.equal(r.unit, "g");
    });

    it("the history UNNEST insert accepts a mixed batch of piece and order rows", async () => {
      const { orderId, pieceIds } = await makePlate({ n: 2, grams: 50 });
      const events = [
        {
          entityType: "piece",
          eventType: "piece_failed",
          orderId,
          orderNumber: "ORD-1",
          pieceId: pieceIds[0]!,
          pieceName: "part-0",
          description: "failed",
        },
        // An ORDER row: piece_id and piece_name are null, which is the case a
        // uniform array shape gets wrong if the casts are missing.
        {
          entityType: "order",
          eventType: "bed_outcome_recorded",
          orderId,
          orderNumber: "ORD-1",
          pieceId: null,
          pieceName: null,
          description: "triaged",
        },
      ];
      await pool.query(
        `
      INSERT INTO order_history (
        company_id, entity_type, event_type, order_id, order_number,
        piece_id, piece_name, description
      )
      SELECT $1, e.entity_type, e.event_type, e.order_id, e.order_number,
             e.piece_id, e.piece_name, e.description
        FROM UNNEST($2::text[], $3::text[], $4::uuid[], $5::text[],
                    $6::uuid[], $7::text[], $8::text[])
          AS e(entity_type, event_type, order_id, order_number,
               piece_id, piece_name, description)
        `,
        [
          companyId,
          events.map((e) => e.entityType),
          events.map((e) => e.eventType),
          events.map((e) => e.orderId),
          events.map((e) => e.orderNumber),
          events.map((e) => e.pieceId),
          events.map((e) => e.pieceName),
          events.map((e) => e.description),
        ],
      );
      const got = await pool.query(
        `SELECT entity_type, piece_id FROM order_history WHERE order_id = $1 ORDER BY entity_type`,
        [orderId],
      );
      assert.equal(got.rowCount, 2);
      assert.equal(got.rows[0].entity_type, "order");
      assert.equal(got.rows[0].piece_id, null);
      assert.equal(got.rows[1].entity_type, "piece");
      assert.equal(got.rows[1].piece_id, pieceIds[0]);
    });

    // ── The whole settle, end to end ────────────────────────────────────────

    it("a mixed plate settles stock by the kernel's number and leaves the rest reserved-free", async () => {
      // 10 pieces at 50g = a 500g plate. 6 done, 2 failed (30g each measured),
      // 2 never started. Expected: 300g of good parts + 60g wasted = 360g off
      // the spool, and 100g that never left it.
      const { pieceIds } = await makePlate({ n: 10, grams: 50 });
      const spoolId = randomUUID();
      await pool.query(
        `INSERT INTO asset_stock (asset_id, remaining_grams, reserved_grams) VALUES ($1, 1000, 500)`,
        [spoolId],
      );
      await pool.query(
        `INSERT INTO order_piece_spools (company_id, piece_id, spool_asset_id, planned_grams)
         VALUES ($1, $2, $3, 500)`,
        [companyId, pieceIds[0], spoolId],
      );

      const platePieces = pieceIds.map((id) => ({ piece_id: id, quoteQuantity: 50 }));
      const settlement = settlePlate(
        platePieces,
        pieceIds.map((id, i) => ({
          piece_id: id,
          outcome: i < 6 ? ("done" as const) : i < 8 ? ("failed" as const) : ("not_started" as const),
          ...(i >= 6 && i < 8 ? { waste: 30 } : {}),
        })),
        500,
        false,
      );
      assert.equal(settlement.deduct, 360);

      for (const alloc of splitAcrossSpools(
        [{ spoolAssetId: spoolId, plannedGrams: 500 }],
        settlement.deduct,
      )) {
        await pool.query(
          `UPDATE asset_stock
              SET remaining_grams = GREATEST(0, COALESCE(remaining_grams, 0) - $2),
                  status = CASE
                             WHEN GREATEST(0, COALESCE(remaining_grams, 0) - $2) <= 0
                               THEN 'empty' ELSE status
                           END
            WHERE asset_id = $1`,
          [alloc.spoolAssetId, alloc.grams],
        );
      }
      await pool.query(
        `DELETE FROM order_piece_spools WHERE company_id = $1 AND piece_id = ANY($2::uuid[])`,
        [companyId, pieceIds],
      );

      const stock = await pool.query(
        `SELECT remaining_grams::float8 AS g, status FROM asset_stock WHERE asset_id = $1`,
        [spoolId],
      );
      // 1000 − 360. The 100g of never-printed parts stayed on the spool, and
      // the reservation is gone rather than lingering against a finished run.
      assert.equal(stock.rows[0].g, 640);
      assert.equal(stock.rows[0].status, "available");
      const leftover = await pool.query(
        `SELECT count(*)::int AS n FROM order_piece_spools WHERE company_id = $1`,
        [companyId],
      );
      assert.equal(leftover.rows[0].n, 0);
    });

    it("a plate that consumes everything empties the spool, exactly as complete({done}) would", async () => {
      const { pieceIds } = await makePlate({ n: 4, grams: 25 });
      const spoolId = randomUUID();
      await pool.query(
        `INSERT INTO asset_stock (asset_id, remaining_grams, reserved_grams) VALUES ($1, 100, 100)`,
        [spoolId],
      );
      const settlement = settlePlate(
        pieceIds.map((id) => ({ piece_id: id, quoteQuantity: 25 })),
        pieceIds.map((id) => ({ piece_id: id, outcome: "done" as const })),
        100,
        false,
      );
      for (const alloc of splitAcrossSpools(
        [{ spoolAssetId: spoolId, plannedGrams: 100 }],
        settlement.deduct,
      )) {
        await pool.query(
          `UPDATE asset_stock
              SET remaining_grams = GREATEST(0, COALESCE(remaining_grams, 0) - $2),
                  status = CASE
                             WHEN GREATEST(0, COALESCE(remaining_grams, 0) - $2) <= 0
                               THEN 'empty' ELSE status
                           END
            WHERE asset_id = $1`,
          [alloc.spoolAssetId, alloc.grams],
        );
      }
      const stock = await pool.query(
        `SELECT remaining_grams::float8 AS g, status FROM asset_stock WHERE asset_id = $1`,
        [spoolId],
      );
      assert.equal(stock.rows[0].g, 0);
      assert.equal(stock.rows[0].status, "empty");
    });

    it("a resin plate draws millilitres from its tank, not grams", async () => {
      const { pieceIds } = await makePlate({ n: 4, grams: 25, tech: "MSLA" });
      const tankId = randomUUID();
      await pool.query(
        `INSERT INTO asset_stock (asset_id, remaining_volume_ml) VALUES ($1, 500)`,
        [tankId],
      );
      // 2 done (50ml), 1 failed measuring 40ml — clamped to its 25ml share,
      // because a vat cannot give up more than the job drew from it.
      const settlement = settlePlate(
        pieceIds.map((id) => ({ piece_id: id, quoteQuantity: 25 })),
        [
          { piece_id: pieceIds[0]!, outcome: "done" },
          { piece_id: pieceIds[1]!, outcome: "done" },
          { piece_id: pieceIds[2]!, outcome: "failed", waste: 40 },
          { piece_id: pieceIds[3]!, outcome: "not_started" },
        ],
        100,
        true,
      );
      assert.equal(settlement.wasteTotal, 25);
      assert.equal(settlement.deduct, 75);

      await pool.query(
        `UPDATE asset_stock
            SET remaining_volume_ml = GREATEST(0, COALESCE(remaining_volume_ml, 0) - $2),
                status = CASE
                           WHEN GREATEST(0, COALESCE(remaining_volume_ml, 0) - $2) <= 0
                             THEN 'empty' ELSE status
                         END
          WHERE asset_id = $1`,
        [tankId, settlement.deduct],
      );
      const stock = await pool.query(
        `SELECT remaining_volume_ml::float8 AS ml FROM asset_stock WHERE asset_id = $1`,
        [tankId],
      );
      assert.equal(stock.rows[0].ml, 425);
    });

    it("a resin piece re-queued to 'assigned' carries a tank and NO nozzle", async () => {
      // 2026-08-15_resin_has_no_nozzle_or_spool.sql exists because a COALESCE
      // once kept a dead nozzle on resin work forever. The re-queue writes both
      // columns explicitly for exactly that reason.
      const { pieceIds } = await makePlate({ n: 1, grams: 25, tech: "MSLA" });
      const tankId = randomUUID();
      await pool.query(
        `UPDATE order_pieces
            SET bed_id = NULL, status = 'assigned', assigned_printer_id = $2,
                assigned_nozzle_asset_id = $3, resin_tank_id = $4
          WHERE piece_id = $1`,
        [pieceIds[0], printerId, null, tankId],
      );
      const row = await pool.query(
        `SELECT assigned_nozzle_asset_id, resin_tank_id FROM order_pieces WHERE piece_id = $1`,
        [pieceIds[0]],
      );
      assert.equal(row.rows[0].assigned_nozzle_asset_id, null);
      assert.equal(row.rows[0].resin_tank_id, tankId);
    });

    it("the plate closes with the same stamp complete() applies", async () => {
      const { bedId } = await makePlate({ n: 2, grams: 10 });
      await pool.query(
        `UPDATE print_beds
            SET status                    = $3,
                print_started_at          = COALESCE(print_started_at, scheduled_start_at, now()),
                print_completed_at        = now(),
                actual_print_time_minutes = COALESCE($4, actual_print_time_minutes)
          WHERE company_id = $1 AND bed_id = $2`,
        [companyId, bedId, "done", 190],
      );
      const row = await pool.query(
        `SELECT status, print_started_at, print_completed_at, actual_print_time_minutes
           FROM print_beds WHERE bed_id = $1`,
        [bedId],
      );
      assert.equal(row.rows[0].status, "done");
      assert.equal(row.rows[0].actual_print_time_minutes, 190);
      assert.ok(row.rows[0].print_started_at instanceof Date);
      assert.ok(row.rows[0].print_completed_at instanceof Date);
    });

    it("two operators settling the same plate cannot both succeed", async () => {
      // THE RACE. The status gate at the top of recordOutcome runs outside any
      // transaction, so two callers can both pass it. Settling twice deducts the
      // material twice and posts the spoilage twice — invisible afterwards
      // without reconciling the spool against the shelf. The FOR UPDATE claim
      // inside the transaction is what makes the second caller lose.
      const { bedId } = await makePlate({ n: 2, grams: 10 });
      const a = await pool.connect();
      const b = await pool.connect();
      try {
        await a.query("BEGIN");
        await b.query("BEGIN");

        // A claims the plate and closes it.
        const claimA = await a.query(
          `SELECT status FROM print_beds WHERE company_id = $1 AND bed_id = $2 FOR UPDATE`,
          [companyId, bedId],
        );
        assert.equal(claimA.rows[0].status, "printing");
        await a.query(`UPDATE print_beds SET status = 'done' WHERE bed_id = $1`, [bedId]);

        // B's claim must BLOCK rather than read the stale 'printing'. Proven by
        // racing it against a timer: if the lock were missing, B returns at once.
        let bResolved = false;
        const bClaim = b
          .query(`SELECT status FROM print_beds WHERE company_id = $1 AND bed_id = $2 FOR UPDATE`, [
            companyId,
            bedId,
          ])
          .then((r) => {
            bResolved = true;
            return r;
          });
        await new Promise((r) => setTimeout(r, 250));
        assert.equal(bResolved, false, "B read the row while A still held it — the lock is not doing its job");

        await a.query("COMMIT");
        const rowsB = await bClaim;
        // B now sees what A committed, and the service's re-assert refuses it.
        assert.equal(rowsB.rows[0].status, "done");
        await b.query("COMMIT");
      } finally {
        a.release();
        b.release();
      }
    });

    it("a fully dismantled plate keeps its row and loses its pieces", async () => {
      // The bed survives as the record of the run; the queue drops it on its
      // own because every queue read gates a plate on it still having pieces.
      const { bedId, pieceIds } = await makePlate({ n: 3, grams: 10 });
      await pool.query(
        `UPDATE order_pieces SET status = 'done', bed_id = NULL WHERE piece_id = ANY($1::uuid[])`,
        [pieceIds],
      );
      const bed = await pool.query(`SELECT bed_id FROM print_beds WHERE bed_id = $1`, [bedId]);
      assert.equal(bed.rowCount, 1);
      const left = await pool.query(
        `SELECT count(*)::int AS n FROM order_pieces WHERE bed_id = $1`,
        [bedId],
      );
      assert.equal(left.rows[0].n, 0);
    });
  },
);
