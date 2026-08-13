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
  techCompatible,
  techFamily,
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
