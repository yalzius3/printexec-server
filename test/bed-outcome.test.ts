// Pure unit tests for the bed outcome settlement kernel. No database required.
//
// WHY THESE EXIST. This is the arithmetic that decides how much filament leaves
// a shop's stock and how much is posted to the ledger as spoilage when a plate
// comes off the printer partly good. Nothing about that is visible from the
// screen that triggers it: an operator triages 300 pieces, presses one button,
// and the only evidence a share was wrong is a gram figure drifting away from
// the shelf over months. So every branch is pinned here, at the shapes that
// actually occur — fully quoted plates, partly quoted ones, unquoted ones,
// stopped-early runs, and the over-measured failure.
//
// Run: node --test "test/bed-outcome.test.ts"   (see package.json scripts)

import test from "node:test";
import assert from "node:assert/strict";
import {
  pieceShares,
  pieceWeights,
  requeueStatus,
  settlePlate,
  splitAcrossSpools,
  type OutcomeInput,
  type PlatePiece,
} from "../src/beds/outcome.ts";

/** Floats: compare to the cent-ish precision the callers round to anyway. */
function near(actual: number, expected: number, msg?: string): void {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    msg ?? `expected ${expected}, got ${actual}`,
  );
}

function piece(id: string, quote: number | null): PlatePiece {
  return { piece_id: id, quoteQuantity: quote };
}

// ── Weights ─────────────────────────────────────────────────────────────────

test("pieceWeights: a quoted piece weighs its own quote", () => {
  const w = pieceWeights([piece("a", 10), piece("b", 30)]);
  near(w.get("a")!, 10);
  near(w.get("b")!, 30);
});

test("pieceWeights: an unquoted piece weighs the average of the quoted ones", () => {
  // Quoted: 10 and 30 → mean 20. The unquoted piece is treated as typical.
  const w = pieceWeights([piece("a", 10), piece("b", 30), piece("c", null)]);
  near(w.get("c")!, 20);
});

test("pieceWeights: nothing quoted → every piece weighs 1 (equal split)", () => {
  const w = pieceWeights([piece("a", null), piece("b", null), piece("c", 0)]);
  near(w.get("a")!, 1);
  near(w.get("b")!, 1);
  // 0 is not a quote — a piece quoted at zero grams is unquoted in substance.
  near(w.get("c")!, 1);
});

test("pieceWeights: a negative or non-finite quote falls back, never goes negative", () => {
  const w = pieceWeights([piece("a", 40), piece("b", -5), piece("c", Number.NaN)]);
  near(w.get("b")!, 40);
  near(w.get("c")!, 40);
});

// ── Shares ──────────────────────────────────────────────────────────────────

test("pieceShares: when the plate total IS the sum of quotes, each share is its quote", () => {
  // This is the ordinary case: BedsService.assign seeds the plate's grams from
  // Σ quoteAssumedMeta, so the round trip has to be the identity.
  const pieces = [piece("a", 100), piece("b", 250), piece("c", 150)];
  const shares = pieceShares(pieces, 500);
  near(shares.get("a")!, 100);
  near(shares.get("b")!, 250);
  near(shares.get("c")!, 150);
});

test("pieceShares: an operator-overridden total scales the whole plate by one ratio", () => {
  const pieces = [piece("a", 100), piece("b", 300)];
  const shares = pieceShares(pieces, 200); // half of the quoted 400
  near(shares.get("a")!, 50);
  near(shares.get("b")!, 150);
});

test("pieceShares: shares always sum to the plate quantity exactly", () => {
  // Deliberately awkward numbers — the sum must not drift, because the
  // remainder is what stays on the spool.
  const pieces = [piece("a", 7), piece("b", 11), piece("c", null), piece("d", 3)];
  const shares = pieceShares(pieces, 333.33);
  let total = 0;
  for (const s of shares.values()) total += s;
  near(total, 333.33);
});

test("pieceShares: a plate with no quantity yields zero shares, not NaN", () => {
  const shares = pieceShares([piece("a", 10), piece("b", 20)], 0);
  near(shares.get("a")!, 0);
  near(shares.get("b")!, 0);
});

test("pieceShares: an empty plate is empty, not a division by zero", () => {
  assert.equal(pieceShares([], 500).size, 0);
});

// ── Settlement ──────────────────────────────────────────────────────────────

test("settlePlate: all done consumes the whole plate — same as complete({done})", () => {
  // The new path must agree with the existing all-or-nothing one at its edges,
  // or the two buttons would settle the same plate differently.
  const pieces = [piece("a", 200), piece("b", 300)];
  const outcomes: OutcomeInput[] = [
    { piece_id: "a", outcome: "done" },
    { piece_id: "b", outcome: "done" },
  ];
  const s = settlePlate(pieces, outcomes, 500, false);
  near(s.deduct, 500);
  near(s.wasteTotal, 0);
  near(s.untouched, 0);
  assert.equal(s.doneCount, 2);
});

test("settlePlate: nothing started deducts nothing — the plate keeps its material", () => {
  const pieces = [piece("a", 200), piece("b", 300)];
  const s = settlePlate(pieces, [
    { piece_id: "a", outcome: "not_started" },
    { piece_id: "b", outcome: "not_started" },
  ], 500, false);
  near(s.deduct, 0);
  near(s.untouched, 500);
});

test("settlePlate: the scenario from the spec — 200 done, 12 failed, 88 never started", () => {
  // A plate of 300 identical pieces quoted at 1.6667g each ≈ 500g total.
  const pieces = Array.from({ length: 300 }, (_, i) => piece(`p${i}`, 500 / 300));
  const outcomes: OutcomeInput[] = pieces.map((p, i) => {
    if (i < 200) return { piece_id: p.piece_id, outcome: "done" as const };
    if (i < 212) return { piece_id: p.piece_id, outcome: "failed" as const, waste: 3.75 };
    return { piece_id: p.piece_id, outcome: "not_started" as const };
  });
  const s = settlePlate(pieces, outcomes, 500, false);

  assert.equal(s.doneCount, 200);
  assert.equal(s.failedCount, 12);
  assert.equal(s.notStartedCount, 88);
  near(s.doneShare, (500 / 300) * 200);          // ≈ 333.33g became good parts
  near(s.wasteTotal, 12 * 3.75);                 // 45g measured spoilage
  near(s.untouched, (500 / 300) * 88);           // ≈ 146.67g never left the spool
  near(s.deduct, (500 / 300) * 200 + 45);        // ≈ 378.33g leaves stock
  // The invariant that matters: what leaves plus what stays cannot exceed the
  // plate unless the operator measured MORE waste than was planned.
  assert.ok(s.deduct + s.untouched >= 500 - 1e-9);
});

test("settlePlate: a failed piece with no measured figure loses its whole share", () => {
  const pieces = [piece("a", 100), piece("b", 100)];
  const s = settlePlate(pieces, [
    { piece_id: "a", outcome: "failed" },              // no waste given
    { piece_id: "b", outcome: "done" },
  ], 200, false);
  near(s.wasteTotal, 100);
  near(s.deduct, 200);
});

test("settlePlate: filament waste ABOVE the share is honoured, not clamped", () => {
  // A detached print sprays far more than the part weighs. Clamping would
  // under-report a real loss.
  const pieces = [piece("a", 50)];
  const s = settlePlate(pieces, [{ piece_id: "a", outcome: "failed", waste: 400 }], 50, false);
  near(s.wasteTotal, 400);
  near(s.deduct, 400);
});

test("settlePlate: resin waste IS clamped to the share — a vat gives up only what it drew", () => {
  const pieces = [piece("a", 50)];
  const s = settlePlate(pieces, [{ piece_id: "a", outcome: "failed", waste: 400 }], 50, true);
  near(s.wasteTotal, 50);
});

test("settlePlate: a negative measured waste is floored at zero, never a credit", () => {
  const pieces = [piece("a", 100)];
  const s = settlePlate(pieces, [{ piece_id: "a", outcome: "failed", waste: -30 }], 100, false);
  near(s.wasteTotal, 0);
  near(s.deduct, 0);
});

test("settlePlate: an unmentioned piece defaults to not-started and costs nothing", () => {
  // Fails CLOSED: a payload that lost a row can under-report a loss, never
  // invent one, and never silently marks something done.
  const pieces = [piece("a", 100), piece("b", 100)];
  const s = settlePlate(pieces, [{ piece_id: "a", outcome: "done" }], 200, false);
  assert.equal(s.notStartedCount, 1);
  near(s.deduct, 100);
  assert.equal(s.pieces.find((p) => p.piece_id === "b")!.outcome, "not_started");
});

test("settlePlate: an outcome for a piece NOT on the plate is ignored", () => {
  const pieces = [piece("a", 100)];
  const s = settlePlate(pieces, [
    { piece_id: "a", outcome: "done" },
    { piece_id: "ghost", outcome: "failed", waste: 999 },
  ], 100, false);
  assert.equal(s.pieces.length, 1);
  near(s.wasteTotal, 0);
});

test("settlePlate: an unquoted plate still settles — equal shares, measured waste intact", () => {
  const pieces = [piece("a", null), piece("b", null), piece("c", null), piece("d", null)];
  const s = settlePlate(pieces, [
    { piece_id: "a", outcome: "done" },
    { piece_id: "b", outcome: "done" },
    { piece_id: "c", outcome: "failed", waste: 12 },
    { piece_id: "d", outcome: "not_started" },
  ], 400, false);
  near(s.doneShare, 200);
  near(s.wasteTotal, 12);
  near(s.untouched, 100);
  near(s.deduct, 212);
});

test("settlePlate: a plate with no quantity deducts only what was measured", () => {
  // An unmeasured plate has no shares to spend, but a real loss was still seen.
  const pieces = [piece("a", null), piece("b", null)];
  const s = settlePlate(pieces, [
    { piece_id: "a", outcome: "done" },
    { piece_id: "b", outcome: "failed", waste: 25 },
  ], 0, false);
  near(s.doneShare, 0);
  near(s.wasteTotal, 25);
  near(s.deduct, 25);
});

// ── Spool allocation ────────────────────────────────────────────────────────

test("splitAcrossSpools: a single spool takes the whole quantity", () => {
  const out = splitAcrossSpools([{ spoolAssetId: "s1", plannedGrams: 500 }], 378.33);
  assert.equal(out.length, 1);
  near(out[0]!.grams, 378.33);
});

test("splitAcrossSpools: multicolour splits in proportion to what each held", () => {
  const out = splitAcrossSpools(
    [{ spoolAssetId: "s1", plannedGrams: 300 }, { spoolAssetId: "s2", plannedGrams: 200 }],
    375,
  );
  near(out.find((o) => o.spoolAssetId === "s1")!.grams, 225);
  near(out.find((o) => o.spoolAssetId === "s2")!.grams, 150);
});

test("splitAcrossSpools: the split always sums back to the quantity", () => {
  const spools = [
    { spoolAssetId: "s1", plannedGrams: 137 },
    { spoolAssetId: "s2", plannedGrams: 41 },
    { spoolAssetId: "s3", plannedGrams: 322 },
  ];
  const out = splitAcrossSpools(spools, 199.77);
  near(out.reduce((sum, o) => sum + o.grams, 0), 199.77);
});

test("splitAcrossSpools: zero-planned rows are skipped, not given a share", () => {
  const out = splitAcrossSpools(
    [{ spoolAssetId: "s1", plannedGrams: 100 }, { spoolAssetId: "s2", plannedGrams: 0 }],
    50,
  );
  assert.equal(out.length, 1);
  near(out[0]!.grams, 50);
});

test("splitAcrossSpools: all-zero reservations fall back to an equal split", () => {
  const out = splitAcrossSpools(
    [{ spoolAssetId: "s1", plannedGrams: 0 }, { spoolAssetId: "s2", plannedGrams: 0 }],
    50,
  );
  assert.equal(out.length, 2);
  near(out[0]!.grams, 25);
  near(out[1]!.grams, 25);
});

test("splitAcrossSpools: nothing to split, or nothing to split it over, is empty", () => {
  assert.deepEqual(splitAcrossSpools([], 100), []);
  assert.deepEqual(splitAcrossSpools([{ spoolAssetId: "s1", plannedGrams: 10 }], 0), []);
});

// ── Re-queue target ─────────────────────────────────────────────────────────

test("requeueStatus: 'assigned' needs a printer to inherit from the plate", () => {
  // chk_assigned_requires_printer loses its bed_id escape the moment the piece
  // detaches, so this is the difference between a re-queue and a bare 500.
  assert.equal(requeueStatus("assigned", "printer-1"), "assigned");
  assert.equal(requeueStatus("assigned", null), "pending");
  assert.equal(requeueStatus("pending", "printer-1"), "pending");
  assert.equal(requeueStatus("pending", null), "pending");
});
