// Pure unit tests for the nozzle-pool rules. No database — these always run.
//
// WHAT THEY GUARD. A shop with ten identical 0.4mm brass nozzles should never
// be told a print can't happen at 14:00 because one specific asset row is
// elsewhere. Two things have to agree for that to work: the SERVER substitutes
// a free twin at commit time, and the BOARD places the chip as though it will.
// poolBusyIntervals is the second half — get it wrong in the permissive
// direction and the board offers slots the server then rejects; get it wrong in
// the strict direction and nothing changes for the operator at all.
//
// Run: node --test "test/nozzle-pool.test.ts"   (or npm test)

import test from "node:test";
import assert from "node:assert/strict";
import {
  foldNozzlePools,
  nozzleBusyProbeSql,
  nozzleIdentityLabel,
  nozzlePoolSql,
  nozzleRosterSql,
  poolBusyIntervals,
  type NozzlePoolRow,
} from "../src/jobs/nozzle-pool.ts";
import { nozzleSpecOf } from "../src/simple-jobs/packing.ts";

const T0 = Date.UTC(2026, 7, 21, 9, 0, 0);
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** One pool member with the given busy windows, as [startHour, endHour] pairs. */
const member = (id: string, windows: Array<[number, number, string?]>) => ({
  nozzle_asset_id: id,
  label: id,
  installed_on_printer_id: null,
  busy: windows.map(([s, e, ref], i) => ({
    ref_id: ref ?? `${id}-job${i}`,
    start_at: iso(T0 + s * H),
    end_at: iso(T0 + e * H),
  })),
});

const hours = (list: Array<{ start: number; end: number }>) =>
  list.map((iv) => [(iv.start - T0) / H, (iv.end - T0) / H]);

// ── poolBusyIntervals ──────────────────────────────────────────────────────

test("poolBusyIntervals: one member behaves exactly as that member's own blocks", () => {
  // The single-nozzle printer. Nothing about its scheduling may change.
  const out = poolBusyIntervals([member("A", [[0, 2], [5, 6]])]);
  assert.deepEqual(hours(out), [[0, 2], [5, 6]]);
});

test("poolBusyIntervals: a free twin frees the whole pool", () => {
  // THE BUG. A is booked all day, B is idle — the pool is available all day.
  const out = poolBusyIntervals([member("A", [[0, 8]]), member("B", [])]);
  assert.deepEqual(out, []);
});

test("poolBusyIntervals: blocked only where the busy windows OVERLAP", () => {
  // A: 0-4, B: 2-6  =>  only 2-4 has both committed.
  const out = poolBusyIntervals([member("A", [[0, 4]]), member("B", [[2, 6]])]);
  assert.deepEqual(hours(out), [[2, 4]]);
});

test("poolBusyIntervals: touching windows do not count as overlapping", () => {
  // A ends exactly when B starts: at every instant at least one is free.
  const out = poolBusyIntervals([member("A", [[0, 3]]), member("B", [[3, 6]])]);
  assert.deepEqual(out, []);
});

test("poolBusyIntervals: three nozzles need all three busy", () => {
  const two = poolBusyIntervals([
    member("A", [[0, 6]]),
    member("B", [[1, 5]]),
    member("C", [[9, 10]]),
  ]);
  assert.deepEqual(two, [], "C is free 0-6, so the pool is");
  const all = poolBusyIntervals([
    member("A", [[0, 6]]),
    member("B", [[1, 5]]),
    member("C", [[2, 4]]),
  ]);
  assert.deepEqual(hours(all), [[2, 4]]);
});

test("poolBusyIntervals: two blocks on ONE nozzle never saturate a pool of two", () => {
  // The reason this intersects rather than counting overlaps: a naive "how many
  // blocks cover this instant?" reads 2 here and would wrongly call the pool
  // full while B sits idle all day.
  const out = poolBusyIntervals([member("A", [[0, 4], [1, 5]]), member("B", [])]);
  assert.deepEqual(out, []);
});

test("poolBusyIntervals: a member's own overlapping blocks merge before intersecting", () => {
  const out = poolBusyIntervals([
    member("A", [[0, 3], [2, 6]]), // → one 0-6 run
    member("B", [[1, 8]]),
  ]);
  assert.deepEqual(hours(out), [[1, 6]]);
});

test("poolBusyIntervals: fragmented availability produces several blocked runs", () => {
  const out = poolBusyIntervals([
    member("A", [[0, 4], [6, 10]]),
    member("B", [[2, 8]]),
  ]);
  assert.deepEqual(hours(out), [[2, 4], [6, 8]]);
});

test("poolBusyIntervals: a job's own block never counts against itself", () => {
  // Dragging a piece that currently holds nozzle A. Its own 0-8 block must not
  // make the pool look full, or the piece can't be moved onto its own slot.
  const members = [member("A", [[0, 8, "mine"]]), member("B", [[0, 8]])];
  assert.deepEqual(hours(poolBusyIntervals(members)), [[0, 8]]);
  assert.deepEqual(poolBusyIntervals(members, new Set(["mine"])), []);
});

test("poolBusyIntervals: an empty pool blocks nothing (the caller falls back)", () => {
  assert.deepEqual(poolBusyIntervals([]), []);
});

test("poolBusyIntervals: unparseable or inverted windows are ignored, not trusted", () => {
  // A bad row must not silently become a block that stops work being scheduled.
  const broken = {
    nozzle_asset_id: "A",
    label: "A",
    installed_on_printer_id: null,
    busy: [
      { ref_id: "x", start_at: "not-a-date", end_at: iso(T0 + H) },
      { ref_id: "y", start_at: iso(T0 + 5 * H), end_at: iso(T0 + 2 * H) },
    ],
  };
  assert.deepEqual(poolBusyIntervals([broken]), []);
});

test("poolBusyIntervals: order of members does not change the answer", () => {
  const a = member("A", [[0, 4]]);
  const b = member("B", [[2, 6]]);
  const c = member("C", [[3, 9]]);
  assert.deepEqual(hours(poolBusyIntervals([a, b, c])), hours(poolBusyIntervals([c, b, a])));
});

// ── foldNozzlePools ────────────────────────────────────────────────────────

const row = (o: Partial<NozzlePoolRow> & { nozzle_asset_id: string }): NozzlePoolRow => ({
  nozzle_diameter_mm: 0.4,
  nozzle_material: "brass",
  nozzle_name: null,
  nozzle_brand: null,
  installed_on: null,
  ref_id: null,
  start_at: null,
  end_at: null,
  ...o,
});

test("foldNozzlePools: identical nozzles land in ONE pool", () => {
  const pools = foldNozzlePools(
    [row({ nozzle_asset_id: "A" }), row({ nozzle_asset_id: "B" }), row({ nozzle_asset_id: "C" })],
    nozzleSpecOf,
  );
  assert.equal(pools.length, 1);
  assert.equal(pools[0]!.members.length, 3);
  assert.equal(pools[0]!.spec, nozzleSpecOf(0.4, "brass"));
});

test("foldNozzlePools: different specs are different pools", () => {
  const pools = foldNozzlePools(
    [
      row({ nozzle_asset_id: "A" }),
      row({ nozzle_asset_id: "H", nozzle_material: "hardened" }),
      row({ nozzle_asset_id: "W", nozzle_diameter_mm: 0.6 }),
    ],
    nozzleSpecOf,
  );
  assert.equal(pools.length, 3);
  for (const p of pools) assert.equal(p.members.length, 1);
});

test("foldNozzlePools: material case does not split a pool", () => {
  // The roster is operator-typed free text; "Brass" and "brass" are one thing.
  const pools = foldNozzlePools(
    [row({ nozzle_asset_id: "A", nozzle_material: "Brass" }), row({ nozzle_asset_id: "B", nozzle_material: "brass" })],
    nozzleSpecOf,
  );
  assert.equal(pools.length, 1);
  assert.equal(pools[0]!.members.length, 2);
});

test("foldNozzlePools: numeric diameters arriving as pg strings still match", () => {
  // node-postgres hands back numeric as a string; "0.40" and 0.4 are one spec.
  const pools = foldNozzlePools(
    [row({ nozzle_asset_id: "A", nozzle_diameter_mm: "0.40" }), row({ nozzle_asset_id: "B", nozzle_diameter_mm: 0.4 })],
    nozzleSpecOf,
  );
  assert.equal(pools.length, 1);
});

test("foldNozzlePools: several blocks on one nozzle collapse to one member", () => {
  const pools = foldNozzlePools(
    [
      row({ nozzle_asset_id: "A", ref_id: "j1", start_at: iso(T0), end_at: iso(T0 + H) }),
      row({ nozzle_asset_id: "A", ref_id: "j2", start_at: iso(T0 + 2 * H), end_at: iso(T0 + 3 * H) }),
    ],
    nozzleSpecOf,
  );
  assert.equal(pools[0]!.members.length, 1);
  assert.equal(pools[0]!.members[0]!.busy.length, 2);
});

test("foldNozzlePools: the LEFT JOIN's null row is a member with nothing booked", () => {
  // This is the free twin — dropping it would be dropping the whole point.
  const pools = foldNozzlePools([row({ nozzle_asset_id: "A" })], nozzleSpecOf);
  assert.equal(pools[0]!.members[0]!.busy.length, 0);
});

test("foldNozzlePools: no rows means no pools", () => {
  assert.deepEqual(foldNozzlePools([], nozzleSpecOf), []);
});

// ── nozzleIdentityLabel ────────────────────────────────────────────────────

test("nozzleIdentityLabel: the operator's own name wins, with the spec alongside", () => {
  assert.equal(
    nozzleIdentityLabel({ nozzle_asset_id: "x", nozzle_name: "Bin 3 #2", nozzle_diameter_mm: 0.4, nozzle_material: "brass" }),
    "Bin 3 #2 (0.4mm brass)",
  );
});

test("nozzleIdentityLabel: brand distinguishes when nothing is named", () => {
  assert.equal(
    nozzleIdentityLabel({ nozzle_asset_id: "x", nozzle_brand: "Bambu", nozzle_diameter_mm: 0.4, nozzle_material: "brass" }),
    "Bambu 0.4mm brass",
  );
});

test("nozzleIdentityLabel: an unnamed nozzle still gets something UNIQUE", () => {
  // The point of the whole feature: "fit the 0.4mm brass one" is not an
  // instruction in a drawer of ten 0.4mm brass nozzles. Two unnamed nozzles of
  // the same spec must not read identically.
  const a = nozzleIdentityLabel({ nozzle_asset_id: "abcdef123456", nozzle_diameter_mm: 0.4, nozzle_material: "brass" });
  const b = nozzleIdentityLabel({ nozzle_asset_id: "99887766aabb", nozzle_diameter_mm: 0.4, nozzle_material: "brass" });
  assert.equal(a, "0.4mm brass · abcdef");
  assert.notEqual(a, b);
  assert.equal(nozzleIdentityLabel({ nozzle_asset_id: "abcdef123456" }), "Nozzle abcdef");
});

test("nozzleIdentityLabel: a blank name is not a name", () => {
  assert.equal(
    nozzleIdentityLabel({ nozzle_asset_id: "abcdef123456", nozzle_name: "   ", nozzle_diameter_mm: 0.4, nozzle_material: "brass" }),
    "0.4mm brass · abcdef",
  );
});

// ── The SQL builders ───────────────────────────────────────────────────────
// Shape only — test/nozzle-pool.integration.test.ts executes them for real.

test("SQL builders: the bed half appears only when print_beds exists", () => {
  for (const sql of [nozzlePoolSql, nozzleBusyProbeSql, nozzleRosterSql]) {
    assert.ok(sql(true).includes("print_beds"), `${sql.name}(true) should query beds`);
    assert.ok(!sql(false).includes("print_beds"), `${sql.name}(false) must not`);
  }
});

test("SQL builders: $6 is referenced only in the variant that is given it", () => {
  // Postgres rejects a bind supplying more parameters than the statement uses,
  // so the exclude-bed parameter must appear exactly when the caller pushes it.
  for (const sql of [nozzleBusyProbeSql, nozzleRosterSql]) {
    assert.ok(sql(true).includes("$6"), `${sql.name}(true) should take the bed exclusion`);
    assert.ok(!sql(false).includes("$6"), `${sql.name}(false) must not reference $6`);
  }
  // The pool query excludes nothing — the board does its own self-exclusion.
  assert.ok(!nozzlePoolSql(true).includes("$5"));
});

test("SQL builders: every statement is scoped to one company", () => {
  for (const sql of [nozzlePoolSql, nozzleBusyProbeSql, nozzleRosterSql]) {
    for (const beds of [true, false]) {
      const text = sql(beds);
      const froms = text.match(/FROM\s+(order_pieces|print_beds|printer_nozzle_compatibility)/g) ?? [];
      const scopes = text.match(/company_id = \$1|company_id = pnc\.company_id/g) ?? [];
      assert.ok(scopes.length >= froms.length, `${sql.name}(${beds}) leaves a table unscoped`);
    }
  }
});
