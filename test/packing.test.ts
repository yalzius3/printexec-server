// Pure unit tests for the scheduling kernel. No database required — these
// always run and cover the placement rules the auto-scheduler depends on:
// gap-fitting with margins, nozzle substitution, and least-slack ordering.
//
// Run: node --test "test/packing.test.ts"   (see package.json scripts)

import test from "node:test";
import assert from "node:assert/strict";
import {
  earliestFit,
  earliestFitWithin,
  earliestFitAcross,
  pushInterval,
  isWithinWorkWindow,
  nextAllowedStart,
  openMsBetween,
  chooseNozzle,
  chooseInterchangeableNozzle,
  nozzleFits,
  nozzleSpecKey,
  nozzleSpecOf,
  slackMs,
  compareBySlack,
  orderForFewestSetups,
  type Interval,
  type NozzleOption,
  type WorkWindow,
} from "../src/simple-jobs/packing.ts";
import {
  isSpoolStorage,
  bestSingleSpool,
  combineOrder,
  compareSpoolPreference,
} from "../src/common/spool-choice.ts";

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

// ── Working hours ──────────────────────────────────────────────────────────
// The window constrains the START only — a long print runs on past closing.
// All fixtures use UTC (tzOffsetMinutes 0) unless the test is about offsets.

const WIN = (startHour: number, latestStartHour: number, tzOffsetMinutes = 0): WorkWindow =>
  ({ startHour, latestStartHour, tzOffsetMinutes });
/** 2026-08-01 at a given UTC hour. */
const at = (hour: number, day = 1) => Date.parse(`2026-08-0${day}T${String(hour).padStart(2, "0")}:00:00.000Z`);

test("isWithinWorkWindow: inside, before and after a normal day window", () => {
  const w = WIN(8, 18);
  assert.equal(isWithinWorkWindow(at(7), w), false);
  assert.equal(isWithinWorkWindow(at(8), w), true);
  assert.equal(isWithinWorkWindow(at(17), w), true);
  assert.equal(isWithinWorkWindow(at(18), w), false);   // latest start is exclusive
  assert.equal(isWithinWorkWindow(at(23), w), false);
});

test("isWithinWorkWindow: a window that wraps midnight (night shift)", () => {
  const w = WIN(22, 6);
  assert.equal(isWithinWorkWindow(at(23), w), true);
  assert.equal(isWithinWorkWindow(at(2), w), true);
  assert.equal(isWithinWorkWindow(at(6), w), false);
  assert.equal(isWithinWorkWindow(at(12), w), false);
});

test("isWithinWorkWindow: no window, or a full-day window, never blocks", () => {
  assert.equal(isWithinWorkWindow(at(3), null), true);
  assert.equal(isWithinWorkWindow(at(3), WIN(9, 9)), true);
});

test("nextAllowedStart: waits for this morning's opening", () => {
  assert.equal(nextAllowedStart(at(6), WIN(8, 18)), at(8));
});

test("nextAllowedStart: after closing, rolls to tomorrow's opening", () => {
  assert.equal(nextAllowedStart(at(20), WIN(8, 18)), at(8, 2));
});

test("nextAllowedStart: leaves an instant already inside the window alone", () => {
  assert.equal(nextAllowedStart(at(9), WIN(8, 18)), at(9));
});

test("nextAllowedStart: hours are the SHOP's clock, not the server's", () => {
  // Cairo is UTC+2. 07:00 UTC is 09:00 locally, so an 08:00–18:00 local window
  // is already open — a naive UTC reading would have made the shop wait an hour.
  const cairo = WIN(8, 18, 120);
  assert.equal(nextAllowedStart(at(7), cairo), at(7));
  // 06:00 UTC is 08:00 local exactly — the moment it opens.
  assert.equal(nextAllowedStart(at(6), cairo), at(6));
  // 05:00 UTC is 07:00 local — an hour early, so wait until 06:00 UTC.
  assert.equal(nextAllowedStart(at(5), cairo), at(6));
});

test("earliestFitWithin: a job that would start after hours waits for the morning", () => {
  // Board is clear, but 20:00 is past the 18:00 cut-off.
  assert.equal(earliestFitWithin([], 2 * H, at(20), 0, WIN(8, 18)), at(8, 2));
});

test("earliestFitWithin: a print may RUN past closing, it just can't START then", () => {
  // Starts 17:00, runs 6h to 23:00 — allowed, because only the start is gated.
  assert.equal(earliestFitWithin([], 6 * H, at(17), 0, WIN(8, 18)), at(17));
});

test("earliestFitWithin: a conflict that pushes past closing rolls to the next day", () => {
  // Free at 08:00, but a block occupies 08:00–17:30, so the next free instant
  // is 17:30 — inside the window — and the job lands there.
  const busy: Interval[] = [{ s: at(8), e: at(17) + 30 * MIN }];
  assert.equal(earliestFitWithin(busy, 1 * H, at(8), 0, WIN(8, 18)), at(17) + 30 * MIN);
  // Extend the block past the cut-off and it must wait for tomorrow instead.
  const busy2: Interval[] = [{ s: at(8), e: at(19) }];
  assert.equal(earliestFitWithin(busy2, 1 * H, at(8), 0, WIN(8, 18)), at(8, 2));
});

test("earliestFitWithin: alternating window and conflict pushes still converge", () => {
  // Every day is blocked 08:00-18:00 for three days, so the job can only start
  // once a day is clear — proving the two constraints don't ping-pong forever.
  const busy: Interval[] = [
    { s: at(8, 1), e: at(19, 1) },
    { s: at(8, 2), e: at(19, 2) },
    { s: at(8, 3), e: at(19, 3) },
  ];
  assert.equal(earliestFitWithin(busy, 1 * H, at(8, 1), 0, WIN(8, 18)), at(8, 4));
});

test("earliestFitWithin: a board booked past the old 512-iteration guard still starts IN hours", () => {
  // THE REGRESSION THIS EXISTS FOR.
  //
  // The window and the conflicts push the start alternately, once per booked
  // day. The previous implementation restarted the whole fit on each push and
  // gave up after 512 of them, returning the last conflict-free instant it had
  // — which had never been re-checked against the window. Nothing downstream
  // checks working hours (schedule() validates overlaps only), so past that
  // point the packer silently started prints in the middle of the night.
  //
  // Alternations grow with the backlog: measured at roughly one per twenty
  // items on a five-printer fleet, so ~10,000 items reached it. 700 booked days
  // reproduces it in one call.
  const DAY = 24 * H;
  const midnight = Date.parse("2026-08-01T00:00:00.000Z");
  const busy: Interval[] = [];
  for (let d = 0; d < 700; d++) {
    busy.push({ s: midnight + d * DAY + 8 * H, e: midnight + d * DAY + 18 * H });
  }
  const start = earliestFitWithin(busy, 2 * H, midnight + 8 * H, 5 * MIN, WIN(8, 18));
  assert.equal(isWithinWorkWindow(start, WIN(8, 18)), true, "must start inside working hours");
  // ...and it must still be a real placement, not merely a legal-looking hour.
  for (const iv of busy) {
    assert.ok(!(iv.s - 5 * MIN < start + 2 * H && iv.e + 5 * MIN > start), "must not overlap a booked block");
  }
  // The first free day is the one after the last booked one.
  assert.equal(start, midnight + 700 * DAY + 8 * H);
});

// ── earliestFitAcross + pushInterval ───────────────────────────────────────
// The packer calls these rather than the two above: a job is constrained by its
// printer AND its nozzle AND every spool or tank it draws from, and those are
// separate lists it keeps ordered as it places.

test("earliestFitAcross: separate lists answer exactly as one combined list", () => {
  const printer: Interval[] = [{ s: at(9), e: at(11) }, { s: at(14), e: at(15) }];
  const nozzle: Interval[] = [{ s: at(11), e: at(12) }];
  const spool: Interval[] = [{ s: at(12), e: at(13) }];
  const combined = [...printer, ...nozzle, ...spool];
  assert.equal(
    earliestFitAcross([printer, nozzle, spool], 1 * H, at(8), 0, null),
    earliestFitWithin(combined, 1 * H, at(8), 0, null),
  );
  // 08:00-09:00 is the only hole before the wall of blocks, and a 1h job fits it.
  assert.equal(earliestFitAcross([printer, nozzle, spool], 1 * H, at(8), 0, null), at(8));
  // A 2h job cannot, so it lands after the whole run.
  assert.equal(earliestFitAcross([printer, nozzle, spool], 2 * H, at(8), 0, null), at(15));
});

test("earliestFitAcross: an empty list contributes nothing", () => {
  const printer: Interval[] = [{ s: at(8), e: at(10) }];
  assert.equal(earliestFitAcross([printer, [], []], 1 * H, at(8), 0, null), at(10));
  assert.equal(earliestFitAcross([[], [], []], 1 * H, at(8), 0, null), at(8));
});

test("earliestFitAcross: honours the working window like earliestFitWithin", () => {
  const printer: Interval[] = [{ s: at(8), e: at(19) }];
  assert.equal(earliestFitAcross([printer], 1 * H, at(8), 0, WIN(8, 18)), at(8, 2));
});

test("pushInterval: keeps a list ordered by start whatever order blocks arrive", () => {
  const list: Interval[] = [];
  const arrivals: Interval[] = [
    { s: at(14), e: at(15) }, { s: at(9), e: at(10) }, { s: at(20), e: at(21) },
    { s: at(9), e: at(9) + 30 * MIN }, { s: at(11), e: at(12) },
  ];
  for (const iv of arrivals) pushInterval(list, iv);
  const starts = list.map((iv) => iv.s);
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  assert.equal(list.length, arrivals.length);
  // Ordered insertion is what lets the fit skip sorting, so the answer must be
  // the same as sorting would have given.
  assert.equal(
    earliestFitAcross([list], 1 * H, at(8), 0, null),
    earliestFitWithin(arrivals, 1 * H, at(8), 0, null),
  );
});

test("earliestFitWithin: no window behaves exactly like earliestFit", () => {
  const busy: Interval[] = [{ s: at(8), e: at(12) }];
  assert.equal(
    earliestFitWithin(busy, 1 * H, at(8), 5 * MIN, null),
    earliestFit(busy, 1 * H, at(8), 5 * MIN),
  );
});

// ── Spool preference ───────────────────────────────────────────────────────
// Storage vs Operational Inventory is computed from GRAMS AND LINEAGE, not from
// asset_stock.status — mirroring isSpoolStorage() in the client's windowKit.tsx,
// which renders the badges and the Assets tab filters. These tests pin that
// pairing, because the two drifting apart is invisible until someone compares a
// plan against the Assets screen.

/** A spool at full weight with nothing reserved and no parent = Storage. */
const sealed = (id: string, grams: number) => ({
  spool_asset_id: id, initial_grams: grams, remaining_grams: grams,
  reserved_grams: 0, parent_asset_id: null, free: grams,
});
/** Partially used → Operational Inventory. */
const opened = (id: string, initial: number, remaining: number) => ({
  spool_asset_id: id, initial_grams: initial, remaining_grams: remaining,
  reserved_grams: 0, parent_asset_id: null, free: remaining,
});

test("isSpoolStorage: untouched full spool is Storage", () => {
  assert.equal(isSpoolStorage(sealed("a", 1000)), true);
});

test("isSpoolStorage: a single gram used makes it Operational Inventory", () => {
  assert.equal(isSpoolStorage(opened("a", 1000, 999)), false);
});

test("isSpoolStorage: reserved grams alone make it Operational Inventory", () => {
  // Full weight, but somebody has already claimed part of it.
  assert.equal(isSpoolStorage({
    spool_asset_id: "a", initial_grams: 1000, remaining_grams: 1000,
    reserved_grams: 250, parent_asset_id: null,
  }), false);
});

test("isSpoolStorage: a split child is never Storage, even at full weight", () => {
  assert.equal(isSpoolStorage({
    spool_asset_id: "child", initial_grams: 500, remaining_grams: 500,
    reserved_grams: 0, parent_asset_id: "parent-1",
  }), false);
});

test("isSpoolStorage: unknown grams fall back to Operational Inventory", () => {
  // Matches the client: it only claims "Storage" when it can prove it.
  assert.equal(isSpoolStorage({ spool_asset_id: "a", parent_asset_id: null }), false);
});

test("isSpoolStorage: NUMERIC columns arriving as strings still classify", () => {
  // pg hands back NUMERIC as a string; a naive === would misread every spool.
  assert.equal(isSpoolStorage({
    spool_asset_id: "a", initial_grams: "1000.00", remaining_grams: "1000.00",
    reserved_grams: "0", parent_asset_id: null,
  }), true);
  assert.equal(isSpoolStorage({
    spool_asset_id: "a", initial_grams: "1000.00", remaining_grams: "980.50",
    reserved_grams: "0", parent_asset_id: null,
  }), false);
});

test("isSpoolStorage: status is NOT what decides it", () => {
  // The trap the first implementation fell into. A sealed spool that happens to
  // be mounted is still Storage; a part-used one sitting in the rack is still
  // Operational Inventory. Status doesn't appear in the rule at all.
  assert.equal(isSpoolStorage(sealed("mounted-but-sealed", 1000)), true);
  assert.equal(isSpoolStorage(opened("shelved-but-open", 1000, 400)), false);
});

test("bestSingleSpool: an opened spool beats a fuller sealed one", () => {
  // The sealed spool has more headroom, but the open one already covers the job
  // — no reason to crack a new spool.
  const best = bestSingleSpool([sealed("sealed", 900), opened("open", 1000, 400)], 300);
  assert.equal(best?.spool_asset_id, "open");
});

test("bestSingleSpool: within a tier, the freest wins (not the tightest fit)", () => {
  const best = bestSingleSpool([opened("nearly-spent", 1000, 310), opened("roomy", 1000, 800)], 300);
  assert.equal(best?.spool_asset_id, "roomy");
});

test("bestSingleSpool: falls through to sealed stock when nothing open can cover it", () => {
  const best = bestSingleSpool([opened("open", 1000, 100), sealed("sealed", 900)], 300);
  assert.equal(best?.spool_asset_id, "sealed");
});

test("bestSingleSpool: null when no single spool covers the job", () => {
  assert.equal(bestSingleSpool([opened("a", 1000, 100), sealed("b", 150)], 300), null);
});

test("combineOrder: drains what's open before opening sealed stock", () => {
  const order = combineOrder([
    sealed("sealed-big", 1000),
    opened("open-small", 1000, 120),
    opened("open-big", 1000, 500),
  ]).map((s) => s.spool_asset_id);
  assert.deepEqual(order, ["open-big", "open-small", "sealed-big"]);
});

/** The CLIENT's isSpoolStorage (windowKit.tsx), copied verbatim as an oracle.
 *  Client and server are separate repos, so nothing but a test stops these two
 *  drifting. If this copy ever needs editing to pass, the real implementations
 *  have already diverged and the badges no longer describe what the packer does. */
function isSpoolStorageClient(s: {
  initial_grams?: unknown; remaining_grams?: unknown;
  reserved_grams?: unknown; parent_asset_id?: unknown;
}): boolean {
  const gramsToNum = (value: unknown): number | null => {
    if (value == null) return null;
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : null;
  };
  if (s.parent_asset_id != null && s.parent_asset_id !== "") return false;
  const initial = gramsToNum(s.initial_grams);
  const remaining = gramsToNum(s.remaining_grams);
  if (initial == null || remaining == null) return false;
  return remaining >= initial && (gramsToNum(s.reserved_grams) ?? 0) <= 0;
}

test("isSpoolStorage: agrees with the client's classification on random stock", () => {
  let seed = 0x51ee7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  for (let i = 0; i < 5000; i++) {
    const initial = pick([null, undefined, 0, 250, 1000, "1000.00", "750.5", "not-a-number"]);
    const remaining = pick([null, undefined, 0, 250, 1000, 1200, "1000.00", "999.99", "nope"]);
    const reserved = pick([null, undefined, 0, "0", 0.5, 250, "250.00", -5]);
    const parent = pick([null, undefined, "", "parent-1"]);
    const s = { initial_grams: initial, remaining_grams: remaining, reserved_grams: reserved, parent_asset_id: parent };
    assert.equal(
      isSpoolStorage(s), isSpoolStorageClient(s),
      `drift on ${JSON.stringify(s)}`,
    );
  }
});

test("compareSpoolPreference: identical inventory always plans identically", () => {
  // A plan that reshuffles between two dry runs is impossible to review, so
  // equal-tier equal-free spools fall back to a stable id order.
  const a = opened("bbb", 1000, 500);
  const b = opened("aaa", 1000, 500);
  assert.ok(compareSpoolPreference(a, b) > 0);
  assert.ok(compareSpoolPreference(b, a) < 0);
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

// ── Nozzle policy ──────────────────────────────────────────────────────────

test("chooseNozzle: keep_assigned never substitutes, however much time it costs", () => {
  const d = chooseNozzle({
    assignedId: "A",
    printerId: "P1",
    options: [nozzle("A", "P1"), nozzle("B", "P1")],
    // The assigned nozzle is tied up for 8h; the twin is free right now.
    earliestFor: (id) => (id === "A" ? T0 + 8 * H : T0),
    policy: "keep_assigned",
  });
  assert.equal(d.id, "A");
  assert.equal(d.swapped, false);
  assert.equal(d.startMs, T0 + 8 * H);   // waits rather than swaps
});

test("chooseNozzle: minimise_changes reuses the pinned nozzle even when slower", () => {
  // This is the whole point of the policy: the printer already has B fitted for
  // this spec, so a later job takes B and waits rather than mounting C.
  const d = chooseNozzle({
    assignedId: "A",
    printerId: "P1",
    options: [nozzle("A", "P1"), nozzle("B", "P1"), nozzle("C", "P1")],
    earliestFor: (id) => (id === "B" ? T0 + 5 * H : T0),
    policy: "minimise_changes",
    pinnedId: "B",
  });
  assert.equal(d.id, "B");
  assert.equal(d.startMs, T0 + 5 * H);
  assert.equal(d.swapped, true);        // differs from the assignment
});

test("chooseNozzle: minimise_changes picks the least disruptive nozzle when nothing is pinned", () => {
  // First job of this spec on this printer. The assigned nozzle fits, so it
  // wins outright — no reason to mount anything else.
  const d = chooseNozzle({
    assignedId: "A",
    printerId: "P1",
    options: [nozzle("A", "P1"), nozzle("B", null), nozzle("C", "P2")],
    earliestFor: (id) => (id === "A" ? T0 + 9 * H : T0),
    policy: "minimise_changes",
    pinnedId: null,
  });
  assert.equal(d.id, "A");
  assert.equal(d.swapped, false);
});

test("chooseNozzle: minimise_changes prefers an on-printer nozzle over one needing a walk", () => {
  // Assigned nozzle doesn't fit the spec, so something must be mounted. B is
  // already on this printer; C would have to be carried from P2.
  const d = chooseNozzle({
    assignedId: "X",
    printerId: "P1",
    options: [nozzle("C", "P2"), nozzle("B", "P1")],
    earliestFor: () => T0,
    policy: "minimise_changes",
  });
  assert.equal(d.id, "B");
  assert.equal(d.movedFromPrinterId, null);
});

test("chooseNozzle: a pinned nozzle that no longer fits the spec is ignored", () => {
  // The pin is per printer+spec, so a different spec must not inherit it. If a
  // stale pin ever arrives, fall back rather than plan an incompatible nozzle.
  const d = chooseNozzle({
    assignedId: "A",
    printerId: "P1",
    options: [nozzle("A", "P1"), nozzle("B", "P1")],
    earliestFor: () => T0,
    policy: "minimise_changes",
    pinnedId: "NOT-IN-OPTIONS",
  });
  assert.equal(d.id, "A");
  assert.equal(d.swapped, false);
});

test("chooseNozzle: earliest remains the default when no policy is given", () => {
  const d = chooseNozzle({
    assignedId: "A",
    printerId: "P1",
    options: [nozzle("A", "P1"), nozzle("B", "P1")],
    earliestFor: (id) => (id === "A" ? T0 + 8 * H : T0),
  });
  assert.equal(d.id, "B");
  assert.equal(d.swapped, true);
});

test("nozzleSpecOf: two different nozzles of the same spec are the same spec", () => {
  // The distinction that matters at the machine. A printer wears one nozzle;
  // running the next job on a different 0.4mm brass costs nobody a spanner, so
  // it must NOT read as a replacement. 0.4 -> 0.5 must.
  assert.equal(nozzleSpecOf(0.4, "brass"), nozzleSpecOf(0.4, "Brass"));
  assert.notEqual(nozzleSpecOf(0.4, "brass"), nozzleSpecOf(0.5, "brass"));
  assert.notEqual(nozzleSpecOf(0.4, "brass"), nozzleSpecOf(0.4, "hardened"));
  // "any" is its own bucket, not a wildcard that merges with every spec.
  assert.notEqual(nozzleSpecOf(null, null), nozzleSpecOf(0.4, "brass"));
  assert.equal(nozzleSpecOf(null, null), nozzleSpecOf(null, null));
});

test("nozzleSpecKey: same printer + spec share a key, case-insensitively", () => {
  assert.equal(nozzleSpecKey("P1", 0.4, "Brass"), nozzleSpecKey("P1", 0.4, "brass"));
  assert.notEqual(nozzleSpecKey("P1", 0.4, "brass"), nozzleSpecKey("P2", 0.4, "brass"));
  assert.notEqual(nozzleSpecKey("P1", 0.4, "brass"), nozzleSpecKey("P1", 0.6, "brass"));
  // A missing spec is its own bucket, not a wildcard that merges with others.
  assert.notEqual(nozzleSpecKey("P1", null, null), nozzleSpecKey("P1", 0.4, "brass"));
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

// ── Setup runs: don't alternate nozzle specs for no reason ─────────────────
// The reported bug. Four pieces, identical print time and filament, two needing
// a 0.4 nozzle and two needing 0.5, came out 0.4 / 0.5 / 0.4 / 0.5 — three
// physical nozzle re-fits where one would do. They tie on slack and on
// deadline, so the last tiebreak was the raw queue order.

/** Count spec transitions in a placement order — the re-fits an operator does. */
const refits = (order: readonly { setupKey?: string }[]): number => {
  let n = 0;
  for (let i = 1; i < order.length; i++) if (order[i]!.setupKey !== order[i - 1]!.setupKey) n += 1;
  return n;
};

/** Four interchangeable pieces on one printer, queued alternating by spec. */
const fourAlternating = () => {
  const dl = new Date(T0 + 48 * H).toISOString();
  return [
    { id: "a04", deadline: dl, minutes: 120, setupKey: "P1|0.4|brass" },
    { id: "b05", deadline: dl, minutes: 120, setupKey: "P1|0.5|brass" },
    { id: "c04", deadline: dl, minutes: 120, setupKey: "P1|0.4|brass" },
    { id: "d05", deadline: dl, minutes: 120, setupKey: "P1|0.5|brass" },
  ];
};
const queueOrder = (xs: readonly { id: string }[]) =>
  new Map(xs.map((x, i) => [x.id, i]));

test("compareBySlack: identical pieces group by nozzle spec instead of alternating", () => {
  const items = fourAlternating();
  const idx = queueOrder(items);
  // Sanity: the reported input really does alternate before sorting.
  assert.equal(refits(items), 3);
  const sorted = [...items].sort((a, b) => compareBySlack(a, b, T0, idx));
  assert.equal(refits(sorted), 1, `still alternating: ${sorted.map((s) => s.setupKey).join(" -> ")}`);
  // Both 0.4s adjacent, both 0.5s adjacent — and every piece still placed.
  assert.deepEqual(sorted.map((s) => s.id).sort(), ["a04", "b05", "c04", "d05"]);
});

test("compareBySlack: grouping never reorders jobs that differ in urgency", () => {
  // The tiebreak must not touch anything with a real slack difference — a
  // tighter job keeps its earlier position even if that costs a re-fit.
  const idx = new Map([["urgent05", 0], ["loose04a", 1], ["loose04b", 2]]);
  const items = [
    { id: "loose04a", deadline: new Date(T0 + 90 * H).toISOString(), minutes: 60, setupKey: "P1|0.4|brass" },
    { id: "urgent05", deadline: new Date(T0 + 3 * H).toISOString(), minutes: 60, setupKey: "P1|0.5|brass" },
    { id: "loose04b", deadline: new Date(T0 + 90 * H).toISOString(), minutes: 60, setupKey: "P1|0.4|brass" },
  ];
  const sorted = [...items].sort((a, b) => compareBySlack(a, b, T0, idx));
  assert.equal(sorted[0]!.id, "urgent05");   // tightest still first
});

test("compareBySlack: equal slack but different deadlines still sorts by deadline", () => {
  // Deadline outranks the setup tiebreak, so a shorter job due sooner is not
  // dragged behind a same-spec partner.
  const idx = new Map([["soon05", 0], ["later04", 1]]);
  const soon05 = { id: "soon05", deadline: new Date(T0 + 2 * H).toISOString(), minutes: 60, setupKey: "P1|0.5|brass" };
  const later04 = { id: "later04", deadline: new Date(T0 + 4 * H).toISOString(), minutes: 180, setupKey: "P1|0.4|brass" };
  // Both have 1h of slack; the deadlines differ.
  assert.equal(slackMs(soon05.deadline, T0, soon05.minutes), slackMs(later04.deadline, T0, later04.minutes));
  const sorted = [soon05, later04].sort((a, b) => compareBySlack(a, b, T0, idx));
  assert.equal(sorted[0]!.id, "soon05");
});

test("orderForFewestSetups: batches whole runs, most urgent run first", () => {
  const idx = new Map([["u05", 0], ["a04", 1], ["b04", 2], ["c05", 3]]);
  const items = [
    { id: "u05", deadline: new Date(T0 + 3 * H).toISOString(), minutes: 60, setupKey: "P1|0.5|brass" },
    { id: "a04", deadline: new Date(T0 + 40 * H).toISOString(), minutes: 60, setupKey: "P1|0.4|brass" },
    { id: "b04", deadline: new Date(T0 + 50 * H).toISOString(), minutes: 60, setupKey: "P1|0.4|brass" },
    { id: "c05", deadline: new Date(T0 + 60 * H).toISOString(), minutes: 60, setupKey: "P1|0.5|brass" },
  ];
  const out = orderForFewestSetups(items, T0, idx);
  // The 0.5 run owns the tightest job, so it goes first — and c05 is pulled
  // forward into it rather than left to force a third re-fit later.
  assert.deepEqual(out.map((o) => o.id), ["u05", "c05", "a04", "b04"]);
  assert.equal(refits(out), 1);
});

test("orderForFewestSetups: keeps each printer's runs separate", () => {
  // setupKey includes the printer, so two machines never merge into one run.
  const idx = new Map([["p1a", 0], ["p2a", 1], ["p1b", 2]]);
  const dl = new Date(T0 + 40 * H).toISOString();
  const items = [
    { id: "p1a", deadline: dl, minutes: 60, setupKey: "P1|0.4|brass" },
    { id: "p2a", deadline: dl, minutes: 60, setupKey: "P2|0.4|brass" },
    { id: "p1b", deadline: dl, minutes: 60, setupKey: "P1|0.4|brass" },
  ];
  const out = orderForFewestSetups(items, T0, idx);
  const keys = out.map((o) => o.setupKey);
  assert.deepEqual(keys, ["P1|0.4|brass", "P1|0.4|brass", "P2|0.4|brass"]);
});

test("orderForFewestSetups: places every job exactly once", () => {
  const items = fourAlternating();
  const out = orderForFewestSetups(items, T0, queueOrder(items));
  assert.deepEqual(out.map((o) => o.id).sort(), ["a04", "b05", "c04", "d05"]);
  assert.equal(refits(out), 1);
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

// ── openMsBetween ─────────────────────────────────────────────────────────
// The denominator behind "share of the hours you could start work in". A plan's
// wall-clock span counts closed nights against the shop, so a fleet that fills
// every staffed hour still reads ~40% — the number that made auto-schedule look
// like it was idling machines. These pin the rule the report divides by.

test("openMsBetween: no window means every instant is open", () => {
  const from = Date.parse("2026-08-24T00:00:00Z");
  const to = Date.parse("2026-08-25T00:00:00Z");
  assert.equal(openMsBetween(from, to, null), 24 * H);
  // A window whose bounds are equal never blocks anything, same as none.
  assert.equal(
    openMsBetween(from, to, { startHour: 9, latestStartHour: 9, tzOffsetMinutes: 0 }),
    24 * H,
  );
});

test("openMsBetween: counts only the staffed band, per day", () => {
  const w: WorkWindow = { startHour: 8, latestStartHour: 18, tzOffsetMinutes: 0 };
  const midnight = Date.parse("2026-08-24T00:00:00Z");
  assert.equal(openMsBetween(midnight, midnight + 24 * H, w), 10 * H);
  assert.equal(openMsBetween(midnight, midnight + 72 * H, w), 30 * H);
  // A range lying entirely after closing contributes nothing — this is the
  // "ran the pack at 19:00" case, where the whole evening is shut.
  assert.equal(
    openMsBetween(Date.parse("2026-08-24T19:00:00Z"), Date.parse("2026-08-24T23:00:00Z"), w),
    0,
  );
  assert.equal(openMsBetween(midnight + 24 * H, midnight, w), 0); // to <= from
});

test("openMsBetween: a night shift wraps midnight", () => {
  const night: WorkWindow = { startHour: 22, latestStartHour: 6, tzOffsetMinutes: 0 };
  const midnight = Date.parse("2026-08-24T00:00:00Z");
  // 00:00–06:00 plus 22:00–24:00 = 8h in any single day.
  assert.equal(openMsBetween(midnight, midnight + 24 * H, night), 8 * H);
});

test("openMsBetween: hours are the SHOP's, not the server's", () => {
  // Cairo is UTC+2, so its 08:00–18:00 is 06:00–16:00 UTC. Counting a local day
  // that starts at 22:00 UTC must still yield the full ten hours.
  const cairo: WorkWindow = { startHour: 8, latestStartHour: 18, tzOffsetMinutes: 120 };
  assert.equal(
    openMsBetween(Date.parse("2026-08-23T22:00:00Z"), Date.parse("2026-08-24T22:00:00Z"), cairo),
    10 * H,
  );
});

test("openMsBetween: agrees with a minute-by-minute count over random windows", () => {
  // Independent oracle — brute force asks isWithinWorkWindow once per minute,
  // so agreement means the closed-form day walk carries no off-by-one at a
  // band edge, a midnight wrap, or a timezone shift.
  const MIN = 60_000;
  const brute = (from: number, to: number, w: WorkWindow): number => {
    let n = 0;
    for (let t = from; t < to; t += MIN) if (isWithinWorkWindow(t, w)) n += MIN;
    return n;
  };
  let seed = 20260821;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const base = Date.parse("2026-08-24T00:00:00Z");
  const offsets = [0, 120, -300, 330, -480, 60];
  for (let i = 0; i < 600; i++) {
    const w: WorkWindow = {
      startHour: Math.floor(rnd() * 24),
      latestStartHour: Math.floor(rnd() * 24),
      tzOffsetMinutes: offsets[Math.floor(rnd() * offsets.length)]!,
    };
    if (w.startHour === w.latestStartHour) continue; // no-op window, covered above
    const from = base + Math.floor(rnd() * 5 * 1440) * MIN;
    const to = from + Math.floor(rnd() * 4 * 1440) * MIN;
    assert.equal(openMsBetween(from, to, w), brute(from, to, w),
      `window ${JSON.stringify(w)} over ${new Date(from).toISOString()}..${new Date(to).toISOString()}`);
  }
});

// ── chooseInterchangeableNozzle ────────────────────────────────────────────
// The manual-drop counterpart of chooseNozzle: the operator has fixed WHEN, so
// the only freedom left is WHICH physical nozzle. Same interchangeability rule
// (diameter + material), no time trading.

/** A nozzle of an arbitrary spec, for the "not identical" cases. */
const nozzleSpec = (
  id: string, installedOn: string | null,
  dia: number | null, mat: string | null,
  status = "available",
): NozzleOption => ({
  nozzle_asset_id: id,
  nozzle_diameter_mm: dia,
  nozzle_material: mat,
  status,
  installed_on: installedOn,
  label: `${dia ?? "any"}mm ${mat ?? "any"} (${id})`,
});

/** The shop in the bug report: every nozzle on the printer is a 0.4mm brass. */
const swapArgs = (options: NozzleOption[], free: string[]) => ({
  assignedId: "A",
  assignedDiameterMm: 0.4,
  assignedMaterial: "brass",
  printerId: "P1",
  options,
  isFree: (id: string) => free.includes(id),
});

test("chooseInterchangeableNozzle: takes an identical twin that is free", () => {
  const got = chooseInterchangeableNozzle(
    swapArgs([nozzle("A", "P1"), nozzle("B", "P1")], ["B"]),
  );
  assert.equal(got?.nozzle_asset_id, "B");
});

test("chooseInterchangeableNozzle: returns null when every twin is busy too", () => {
  const got = chooseInterchangeableNozzle(
    swapArgs([nozzle("A", "P1"), nozzle("B", "P1"), nozzle("C", "P1")], []),
  );
  assert.equal(got, null);
});

test("chooseInterchangeableNozzle: never returns the assigned nozzle itself", () => {
  // Even if the caller wrongly reports it free, this only ever answers with a
  // DIFFERENT nozzle — the caller's question was "what else can serve this?".
  const got = chooseInterchangeableNozzle(
    swapArgs([nozzle("A", "P1")], ["A"]),
  );
  assert.equal(got, null);
});

test("chooseInterchangeableNozzle: a different spec is NOT a substitute", () => {
  // 0.4 hardened and 0.5 brass are both free; neither prints the same part.
  const got = chooseInterchangeableNozzle(
    swapArgs(
      [nozzle("A", "P1"), nozzleSpec("H", "P1", 0.4, "hardened"), nozzleSpec("W", "P1", 0.5, "brass")],
      ["H", "W"],
    ),
  );
  assert.equal(got, null);
});

test("chooseInterchangeableNozzle: material match ignores case", () => {
  const got = chooseInterchangeableNozzle(
    swapArgs([nozzle("A", "P1"), nozzleSpec("B", "P1", 0.4, "Brass")], ["B"]),
  );
  assert.equal(got?.nozzle_asset_id, "B");
});

test("chooseInterchangeableNozzle: a damaged twin is never chosen", () => {
  const got = chooseInterchangeableNozzle(
    swapArgs([nozzle("A", "P1"), nozzleSpec("D", "P1", 0.4, "brass", "damaged")], ["D"]),
  );
  assert.equal(got, null);
});

test("chooseInterchangeableNozzle: 'installed' and 'in_use' twins are perfectly usable", () => {
  // Only 'damaged' rules a nozzle out — a fitted nozzle is usually the one we
  // most want, and 'in_use' is about stock bookkeeping, not this time window.
  for (const status of ["installed", "in_use", "available"]) {
    const got = chooseInterchangeableNozzle(
      swapArgs([nozzle("A", "P1"), nozzleSpec("B", "P1", 0.4, "brass", status)], ["B"]),
    );
    assert.equal(got?.nozzle_asset_id, "B", `status ${status} should be usable`);
  }
});

test("chooseInterchangeableNozzle: prefers a twin that needs no physical move", () => {
  // B sits on another printer (someone must carry it); C is idle. C wins.
  const got = chooseInterchangeableNozzle(
    swapArgs([nozzle("A", "P1"), nozzle("B", "P2"), nozzle("C", null)], ["B", "C"]),
  );
  assert.equal(got?.nozzle_asset_id, "C");
});

test("chooseInterchangeableNozzle: falls back to one on another printer as a last resort", () => {
  const got = chooseInterchangeableNozzle(
    swapArgs([nozzle("A", "P1"), nozzle("B", "P2"), nozzle("C", null)], ["B"]),
  );
  assert.equal(got?.nozzle_asset_id, "B");
  assert.equal(got?.installed_on, "P2"); // caller must surface the move
});

test("chooseInterchangeableNozzle: equal-rank ties resolve deterministically", () => {
  // Two identical idle twins — a retry of the same drop must pick the same one,
  // or two operators watching the same board see different answers.
  const opts = [nozzle("A", "P1"), nozzle("Z", "P1"), nozzle("M", "P1")];
  const first = chooseInterchangeableNozzle(swapArgs(opts, ["Z", "M"]));
  const again = chooseInterchangeableNozzle(swapArgs([...opts].reverse(), ["Z", "M"]));
  assert.equal(first?.nozzle_asset_id, "M");
  assert.equal(again?.nozzle_asset_id, "M");
});

test("chooseInterchangeableNozzle: a spec-less nozzle only stands in for a spec-less one", () => {
  // nozzleSpecOf buckets null as "any" rather than as a wildcard, so an
  // unrecorded nozzle can't quietly stand in for a known 0.4mm brass.
  const blank = nozzleSpec("N", "P1", null, null);
  assert.equal(
    chooseInterchangeableNozzle(swapArgs([nozzle("A", "P1"), blank], ["N"])),
    null,
  );
  assert.equal(
    chooseInterchangeableNozzle({
      ...swapArgs([nozzleSpec("A", "P1", null, null), blank], ["N"]),
      assignedDiameterMm: null,
      assignedMaterial: null,
    })?.nozzle_asset_id,
    "N",
  );
});

test("chooseInterchangeableNozzle: an empty roster yields no substitute", () => {
  assert.equal(chooseInterchangeableNozzle(swapArgs([], ["B"])), null);
});
