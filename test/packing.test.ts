// Pure unit tests for the scheduling kernel. No database required — these
// always run and cover the placement rules the auto-scheduler depends on:
// gap-fitting with margins, nozzle substitution, and least-slack ordering.
//
// Run: node --test "test/packing.test.ts"   (see package.json scripts)

import test from "node:test";
import assert from "node:assert/strict";
import {
  earliestFit,
  chooseNozzle,
  nozzleFits,
  slackMs,
  compareBySlack,
  type Interval,
  type NozzleOption,
} from "../src/simple-jobs/packing.ts";

const MIN = 60_000;
const H = 60 * MIN;
// A fixed epoch so every expectation is an exact number, not a relative guess.
const T0 = Date.parse("2026-08-01T09:00:00.000Z");

// ── earliestFit ────────────────────────────────────────────────────────────

test("earliestFit: empty board returns the floor untouched", () => {
  assert.equal(earliestFit([], 2 * H, T0, 5 * MIN), T0);
});

test("earliestFit: a job clear of everything keeps the floor", () => {
  const busy: Interval[] = [{ s: T0 + 10 * H, e: T0 + 12 * H }];
  assert.equal(earliestFit(busy, 1 * H, T0, 5 * MIN), T0);
});

test("earliestFit: overlapping block pushes the start to its end plus the margin", () => {
  const busy: Interval[] = [{ s: T0, e: T0 + 2 * H }];
  assert.equal(earliestFit(busy, 1 * H, T0, 5 * MIN), T0 + 2 * H + 5 * MIN);
});

test("earliestFit: margin 0 lets blocks touch edge-to-edge but never overlap", () => {
  const busy: Interval[] = [{ s: T0, e: T0 + 2 * H }];
  assert.equal(earliestFit(busy, 1 * H, T0, 0), T0 + 2 * H);
});

test("earliestFit: chained blocks settle past all of them", () => {
  // Three back-to-back prints; a 1h job can't fit between any of them.
  const busy: Interval[] = [
    { s: T0, e: T0 + 1 * H },
    { s: T0 + 1 * H, e: T0 + 2 * H },
    { s: T0 + 2 * H, e: T0 + 3 * H },
  ];
  assert.equal(earliestFit(busy, 1 * H, T0, 0), T0 + 3 * H);
});

test("earliestFit: BACKFILLS a gap wide enough to hold the job", () => {
  // 09:00-10:00 busy, then free until 14:00. A 2h job must land at 10:00,
  // not queue behind the afternoon block — this is where utilisation comes from.
  const busy: Interval[] = [
    { s: T0, e: T0 + 1 * H },
    { s: T0 + 5 * H, e: T0 + 8 * H },
  ];
  assert.equal(earliestFit(busy, 2 * H, T0, 0), T0 + 1 * H);
});

test("earliestFit: a job too long for the gap skips past it", () => {
  // Same board, but a 5h job cannot fit in the 4h hole.
  const busy: Interval[] = [
    { s: T0, e: T0 + 1 * H },
    { s: T0 + 5 * H, e: T0 + 8 * H },
  ];
  assert.equal(earliestFit(busy, 5 * H, T0, 0), T0 + 8 * H);
});

test("earliestFit: the margin is applied on BOTH sides of a gap", () => {
  // 4h hole, 5 min margin each side => only 3h50m usable. A 4h job must skip it.
  const busy: Interval[] = [
    { s: T0, e: T0 + 1 * H },
    { s: T0 + 5 * H, e: T0 + 8 * H },
  ];
  assert.equal(earliestFit(busy, 4 * H, T0, 5 * MIN), T0 + 8 * H + 5 * MIN);
  // ...but a 3h45m job still fits inside it, after the leading margin.
  assert.equal(earliestFit(busy, 3 * H + 45 * MIN, T0, 5 * MIN), T0 + 1 * H + 5 * MIN);
});

test("earliestFit: unsorted input gives the same answer as sorted", () => {
  const busy: Interval[] = [
    { s: T0 + 5 * H, e: T0 + 8 * H },
    { s: T0, e: T0 + 1 * H },
    { s: T0 + 2 * H, e: T0 + 3 * H },
  ];
  const shuffled = [busy[2]!, busy[0]!, busy[1]!];
  assert.equal(earliestFit(busy, 1 * H, T0, 0), earliestFit(shuffled, 1 * H, T0, 0));
});

test("earliestFit: never returns a start before the floor", () => {
  const busy: Interval[] = [{ s: T0 - 10 * H, e: T0 - 5 * H }];
  assert.equal(earliestFit(busy, 1 * H, T0, 5 * MIN), T0);
});

// ── earliestFit: single-pass rewrite ───────────────────────────────────────
// The original was a fixed-point loop (rescan until a pass moves nothing).
// That LOOKED quadratic but never was: it always settled in one working pass
// plus one confirming pass, confirmed by fuzzing 200k random boards (observed
// max: 2). The rewrite buys clarity and about half the comparisons, not a
// complexity class — so the test that matters is the differential one, which
// proves the two agree, not a benchmark.

/** The original implementation, kept verbatim as a reference oracle. */
function earliestFitNaive(
  busy: readonly Interval[], durMs: number, notBefore: number, gapMs: number,
): number {
  if (busy.length === 0) return notBefore;
  const sorted = [...busy].sort((a, b) => a.s - b.s);
  let start = notBefore;
  let moved = true;
  while (moved) {
    moved = false;
    for (const iv of sorted) {
      if (start < iv.e + gapMs && start + durMs > iv.s - gapMs) {
        start = iv.e + gapMs;
        moved = true;
      }
    }
  }
  return start;
}

test("earliestFit: agrees with the previous implementation on random boards", () => {
  // Deterministic PRNG so a failure is reproducible from the seed alone.
  let seed = 0x2f6e2b1;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let trial = 0; trial < 3000; trial++) {
    const n = 1 + Math.floor(rnd() * 12);
    const busy: Interval[] = [];
    for (let i = 0; i < n; i++) {
      // Deliberately overlapping, adjacent and out-of-order blocks.
      const s = T0 + Math.floor(rnd() * 20) * 30 * MIN;
      const e = s + (1 + Math.floor(rnd() * 6)) * 30 * MIN;
      busy.push({ s, e });
    }
    const dur = (1 + Math.floor(rnd() * 5)) * 30 * MIN;
    const gap = [0, 5 * MIN, 15 * MIN][Math.floor(rnd() * 3)]!;
    const floor = T0 + Math.floor(rnd() * 6) * 30 * MIN;
    assert.equal(
      earliestFit(busy, dur, floor, gap),
      earliestFitNaive(busy, dur, floor, gap),
      `mismatch on trial ${trial}: ${JSON.stringify({ busy, dur, gap, floor })}`,
    );
  }
});

test("earliestFit: a long chain of back-to-back blocks resolves correctly", () => {
  // A full day-chain of prints: the job belongs right after the last one. This
  // is a correctness test on a big board (and a loose guard against someone
  // reintroducing a genuinely superlinear scan), NOT a claim about the old
  // implementation — that one handled this shape in a single pass too.
  const N = 4000;
  const busy: Interval[] = [];
  for (let i = 0; i < N; i++) busy.push({ s: T0 + i * H, e: T0 + (i + 1) * H });
  const t = process.hrtime.bigint();
  const got = earliestFit(busy, 30 * MIN, T0, 0);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  assert.equal(got, T0 + N * H);
  assert.ok(ms < 250, `took ${ms.toFixed(1)}ms, expected well under 250ms`);
});

test("earliestFit: stops early instead of scanning a board it has already cleared", () => {
  // The one real win of the rewrite: once an interval starts beyond the job's
  // end, every later one does too, so the scan can stop. A job that fits at the
  // very front of a huge board should not touch most of it.
  const N = 50_000;
  const busy: Interval[] = [];
  for (let i = 0; i < N; i++) busy.push({ s: T0 + (i + 10) * H, e: T0 + (i + 11) * H });
  const t = process.hrtime.bigint();
  const got = earliestFit(busy, 30 * MIN, T0, 0);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  assert.equal(got, T0);                // fits immediately, before block 0
  assert.ok(ms < 250, `took ${ms.toFixed(1)}ms`);
});

// ── nozzleFits ─────────────────────────────────────────────────────────────

test("nozzleFits: diameter must match when the piece states one", () => {
  const n = { nozzle_diameter_mm: 0.4, nozzle_material: "brass" };
  assert.equal(nozzleFits(n, 0.4, null), true);
  assert.equal(nozzleFits(n, 0.6, null), false);
  // No stated requirement => any diameter is acceptable.
  assert.equal(nozzleFits(n, null, null), true);
});

test("nozzleFits: material matches case-insensitively, and only when BOTH state one", () => {
  assert.equal(nozzleFits({ nozzle_diameter_mm: 0.4, nozzle_material: "Brass" }, 0.4, "brass"), true);
  assert.equal(nozzleFits({ nozzle_diameter_mm: 0.4, nozzle_material: "brass" }, 0.4, "hardened"), false);
  // A nozzle with no recorded material is a wildcard (mirrors the assign flow).
  assert.equal(nozzleFits({ nozzle_diameter_mm: 0.4, nozzle_material: null }, 0.4, "hardened"), true);
  // A piece with no stated material accepts any nozzle material.
  assert.equal(nozzleFits({ nozzle_diameter_mm: 0.4, nozzle_material: "brass" }, 0.4, null), true);
});

// ── chooseNozzle ───────────────────────────────────────────────────────────

const nozzle = (id: string, installedOn: string | null): NozzleOption => ({
  nozzle_asset_id: id,
  nozzle_diameter_mm: 0.4,
  nozzle_material: "brass",
  status: "available",
  installed_on: installedOn,
  label: `0.4mm brass (${id})`,
});

test("chooseNozzle: keeps the assigned nozzle when nothing is faster", () => {
  const d = chooseNozzle({
    assignedId: "A",
    printerId: "P1",
    options: [nozzle("A", "P1"), nozzle("B", "P1")],
    earliestFor: () => T0,
  });
  assert.equal(d.id, "A");
  assert.equal(d.swapped, false);
  assert.equal(d.startMs, T0);
});

test("chooseNozzle: substitutes when an equivalent nozzle opens an earlier slot", () => {
  // The assigned nozzle is tied up until 17:00; an idle twin is free now.
  const d = chooseNozzle({
    assignedId: "A",
    printerId: "P1",
    options: [nozzle("A", "P1"), nozzle("B", "P1")],
    earliestFor: (id) => (id === "A" ? T0 + 8 * H : T0),
  });
  assert.equal(d.id, "B");
  assert.equal(d.swapped, true);
  assert.equal(d.startMs, T0);
  assert.equal(d.movedFromPrinterId, null); // already on this printer
});

test("chooseNozzle: reports a physical move when the substitute is on another printer", () => {
  const d = chooseNozzle({
    assignedId: "A",
    printerId: "P1",
    options: [nozzle("A", "P1"), nozzle("B", "P2")],
    earliestFor: (id) => (id === "A" ? T0 + 8 * H : T0),
  });
  assert.equal(d.id, "B");
  assert.equal(d.movedFromPrinterId, "P2");
});

test("chooseNozzle: on a tie, prefers a nozzle needing no physical move", () => {
  // Both free now, but the assigned one is busy later — all three tie at T0.
  const d = chooseNozzle({
    assignedId: "A",
    printerId: "P1",
    options: [nozzle("A", "P1"), nozzle("B", "P2"), nozzle("C", null)],
    earliestFor: (id) => (id === "A" ? T0 + 1 * H : T0),
  });
  // C is unmounted (rank 1), B is on another printer (rank 2) => C wins.
  assert.equal(d.id, "C");
});

test("chooseNozzle: never churns for equal time when the assigned nozzle fits", () => {
  const d = chooseNozzle({
    assignedId: "A",
    printerId: "P1",
    options: [nozzle("A", "P1"), nozzle("B", null)],
    earliestFor: () => T0,
  });
  assert.equal(d.id, "A");
  assert.equal(d.swapped, false);
});

test("chooseNozzle: an assigned nozzle that does NOT meet the spec is displaced at equal time", () => {
  // "X" isn't in the fitting options at all (wrong spec) => rank 3, so any
  // conforming nozzle wins even without a time gain.
  const d = chooseNozzle({
    assignedId: "X",
    printerId: "P1",
    options: [nozzle("B", "P1")],
    earliestFor: () => T0,
  });
  assert.equal(d.id, "B");
  assert.equal(d.swapped, true);
});

test("chooseNozzle: no assigned nozzle means no substitution", () => {
  // Assigning a nozzle where a human left it blank is a different decision.
  const d = chooseNozzle({
    assignedId: null,
    printerId: "P1",
    options: [nozzle("B", "P1")],
    earliestFor: () => T0,
  });
  assert.equal(d.id, null);
  assert.equal(d.swapped, false);
});

test("chooseNozzle: empty option set leaves the assignment alone", () => {
  const d = chooseNozzle({
    assignedId: "A",
    printerId: "P1",
    options: [],
    earliestFor: () => T0 + 3 * H,
  });
  assert.equal(d.id, "A");
  assert.equal(d.swapped, false);
  assert.equal(d.startMs, T0 + 3 * H);
});

// ── slack ordering ─────────────────────────────────────────────────────────

test("slackMs: deadline minus now minus duration", () => {
  const deadline = new Date(T0 + 10 * H).toISOString();
  assert.equal(slackMs(deadline, T0, 120), 8 * H);
});

test("slackMs: negative when the job can't make it even starting now", () => {
  const deadline = new Date(T0 + 1 * H).toISOString();
  assert.equal(slackMs(deadline, T0, 180), -2 * H);
});

test("slackMs: no deadline (or an unparseable one) is infinite slack", () => {
  assert.equal(slackMs(null, T0, 60), Infinity);
  assert.equal(slackMs("not a date", T0, 60), Infinity);
});

test("compareBySlack: the tightest job sorts first, not the earliest deadline", () => {
  // The long job is due LATER but is far tighter once its runtime is counted.
  const shortSoon = { id: "short", deadline: new Date(T0 + 2 * H).toISOString(), minutes: 10 };   // slack 1h50
  const longLater = { id: "long", deadline: new Date(T0 + 4 * H).toISOString(), minutes: 210 };  // slack 30m
  const order = new Map([["short", 0], ["long", 1]]);
  const sorted = [shortSoon, longLater].sort((a, b) => compareBySlack(a, b, T0, order));
  assert.deepEqual(sorted.map((j) => j.id), ["long", "short"]);
});

test("compareBySlack: undated work packs last", () => {
  const dated = { id: "dated", deadline: new Date(T0 + 100 * H).toISOString(), minutes: 60 };
  const undated = { id: "undated", deadline: null, minutes: 60 };
  const order = new Map([["undated", 0], ["dated", 1]]);
  const sorted = [undated, dated].sort((a, b) => compareBySlack(a, b, T0, order));
  assert.deepEqual(sorted.map((j) => j.id), ["dated", "undated"]);
});

test("compareBySlack: equal slack falls back to deadline, then to the given order", () => {
  // Identical slack and deadline => original order decides, so the sort is stable
  // and a re-run of the packer produces the same plan.
  const a = { id: "a", deadline: new Date(T0 + 5 * H).toISOString(), minutes: 60 };
  const b = { id: "b", deadline: new Date(T0 + 5 * H).toISOString(), minutes: 60 };
  const order = new Map([["a", 0], ["b", 1]]);
  assert.ok(compareBySlack(a, b, T0, order) < 0);
  assert.ok(compareBySlack(b, a, T0, order) > 0);
});
