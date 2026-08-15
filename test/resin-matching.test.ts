// Pure unit tests for the two RESIN matching rules. No database required.
//
// Both of these were real production failures, and both had the same shape: a
// rule written in FDM's terms that is permanently false for resin, failing
// closed with no error naming the cause. They are pure functions precisely so
// they can be pinned here.
//
// Run: node --test "test/resin-matching.test.ts"   (see package.json scripts)

import test from "node:test";
import assert from "node:assert/strict";
import {
  colorCompatible,
  isResinTech,
  pickTank,
  techCompatible,
  techFamily,
  type TankChoice,
} from "../src/jobs/matching.ts";

// ── techFamily / techCompatible ─────────────────────────────────────────────
// The bug: the assign path folded MSLA+SLA into one family, order-pieces
// compared the raw strings with !==. A resin piece could be assigned to a resin
// printer and then EVERY later edit died on
// "assigned_printer_id does not match required_print_technology" — a piece the
// operator could create but never touch again.

test("techFamily: both resin technologies collapse to one family", () => {
  assert.equal(techFamily("MSLA"), "RESIN");
  assert.equal(techFamily("SLA"), "RESIN");
  assert.equal(techFamily("msla"), "RESIN");
  assert.equal(techFamily("  sla  "), "RESIN");
});

test("techFamily: non-resin technologies keep their own identity", () => {
  assert.equal(techFamily("FDM"), "FDM");
  assert.equal(techFamily("SLS"), "SLS");
  assert.equal(techFamily("fdm"), "FDM");
});

test("techCompatible: an SLA piece prints on an MSLA printer and vice-versa", () => {
  assert.equal(techCompatible("SLA", "MSLA"), true);
  assert.equal(techCompatible("MSLA", "SLA"), true);
});

test("techCompatible: crossing a family is still refused", () => {
  assert.equal(techCompatible("MSLA", "FDM"), false);
  assert.equal(techCompatible("FDM", "SLA"), false);
  assert.equal(techCompatible("SLS", "MSLA"), false);
});

test("techCompatible: an unstated technology on either side constrains nothing", () => {
  assert.equal(techCompatible(null, "MSLA"), true);
  assert.equal(techCompatible("MSLA", null), true);
  assert.equal(techCompatible(undefined, undefined), true);
});

test("techCompatible: same family, same tech is the ordinary case", () => {
  assert.equal(techCompatible("FDM", "FDM"), true);
  assert.equal(techCompatible("MSLA", "MSLA"), true);
});

// ── colorCompatible ─────────────────────────────────────────────────────────
// A resin part cures the colour of the vat and cannot be recoloured, so a
// mismatched tank produces scrap. The subtlety is the WILDCARD: written as
// plain equality, every unlabelled tank (the common case — colour is optional
// at intake) would drop out of every pick list, which is the same fail-closed
// mistake in the other direction.

test("colorCompatible: two stated colours must actually match", () => {
  assert.equal(colorCompatible("Black", "Black"), true);
  assert.equal(colorCompatible("Blue", "Yellow"), false);
});

test("colorCompatible: matching is case- and whitespace-insensitive", () => {
  assert.equal(colorCompatible("black", "BLACK"), true);
  assert.equal(colorCompatible("  Grey ", "grey"), true);
});

test("colorCompatible: a piece that asked for no colour takes any tank", () => {
  assert.equal(colorCompatible(null, "Yellow"), true);
  assert.equal(colorCompatible("", "Yellow"), true);
  assert.equal(colorCompatible("   ", "Yellow"), true);
});

test("colorCompatible: an unlabelled tank can still serve a colour request", () => {
  // The fail-closed trap: strict equality here would hide every tank whose
  // colour nobody recorded, which for resin is most of the shelf.
  assert.equal(colorCompatible("Blue", null), true);
  assert.equal(colorCompatible("Blue", ""), true);
  assert.equal(colorCompatible("Blue", "  "), true);
});

test("colorCompatible: unstated on both sides is unconstrained", () => {
  assert.equal(colorCompatible(null, null), true);
});

// ── isResinTech ─────────────────────────────────────────────────────────────

test("isResinTech: only MSLA and SLA are resin", () => {
  assert.equal(isResinTech("MSLA"), true);
  assert.equal(isResinTech("SLA"), true);
  assert.equal(isResinTech("FDM"), false);
  assert.equal(isResinTech("SLS"), false);
  assert.equal(isResinTech(null), false);
  assert.equal(isResinTech(undefined), false);
  assert.equal(isResinTech(""), false);
});

// ── pickTank ────────────────────────────────────────────────────────────────
// Shared by BOTH assign paths (one-click and the wizard). It was written once
// as a closure inside simple-jobs; the wizard then had no tank resolution at
// all, so filling in a resin piece's print data left it permanently 'assigned'
// — and, before the readiness CASE was corrected, threw a bare 500 instead.
// Callers pass tanks EMPTIEST-FIRST (both order in SQL).

const tanks = (...rows: Array<[string, number | null, string | null]>): TankChoice[] =>
  rows.map(([asset_id, free_ml, resin_color]) => ({ asset_id, free_ml, resin_color }));

test("pickTank: finishes the most depleted tank that still covers the draw", () => {
  const shelf = tanks(["low", 40, "Black"], ["mid", 300, "Black"], ["full", 900, "Black"]);
  assert.equal(pickTank(shelf, { needMl: 100, wantColor: "Black" }), "mid");
});

test("pickTank: an exact fit counts as covering", () => {
  const shelf = tanks(["exact", 100, null], ["big", 900, null]);
  assert.equal(pickTank(shelf, { needMl: 100, wantColor: null }), "exact");
});

test("pickTank: colour is a hard filter, not a preference", () => {
  // The yellow tank has plenty of volume and comes first; it must still lose.
  const shelf = tanks(["yellow", 50, "Yellow"], ["blue", 800, "Blue"]);
  assert.equal(pickTank(shelf, { needMl: 100, wantColor: "Blue" }), "blue");
});

test("pickTank: no tank of the wanted colour returns null, never a wrong colour", () => {
  const shelf = tanks(["yellow", 900, "Yellow"], ["red", 900, "Red"]);
  assert.equal(pickTank(shelf, { needMl: 100, wantColor: "Blue" }), null);
});

test("pickTank: an unlabelled tank can serve a colour request", () => {
  const shelf = tanks(["unlabelled", 900, null]);
  assert.equal(pickTank(shelf, { needMl: 100, wantColor: "Blue" }), "unlabelled");
});

test("pickTank: nothing covers the draw → null, rather than a tank that will fail later", () => {
  const shelf = tanks(["a", 10, null], ["b", 20, null]);
  assert.equal(pickTank(shelf, { needMl: 500, wantColor: null }), null);
});

test("pickTank: volume not known yet takes the most depleted compatible tank", () => {
  // needMl null = the operator fills it in at the slicer step.
  const shelf = tanks(["low", 40, "Grey"], ["high", 900, "Grey"]);
  assert.equal(pickTank(shelf, { needMl: null, wantColor: "Grey" }), "high");
  assert.equal(pickTank(shelf, { needMl: 0, wantColor: "Grey" }), "high");
});

test("pickTank: an empty shelf is null, not a crash", () => {
  assert.equal(pickTank([], { needMl: 100, wantColor: "Black" }), null);
});

test("pickTank: a null free_ml is treated as empty, never as unlimited", () => {
  const shelf = tanks(["unknown", null, null], ["known", 500, null]);
  assert.equal(pickTank(shelf, { needMl: 100, wantColor: null }), "known");
});
