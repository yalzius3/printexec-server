/* Which parts of a piece's specification stay editable, and where they stop.
   The rules that decide whether a part gets printed in the wrong filament, so
   both directions are pinned: what must be allowed AND what must be refused. */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MATERIAL_SPEC_FIELDS,
  TECH_FIELDS,
  pieceSpecEditRefusal,
  type PieceEditContext
} from "../src/order-pieces/piece-edit-lock.ts";

const piece = (over: Partial<PieceEditContext> = {}): PieceEditContext => ({
  status: "pending",
  order_status: "in_production",
  bed_id: null,
  ...over
});

const COLOUR = ["required_color"];
const MATERIAL = ["required_filament_material"];
const NOZZLE = ["required_nozzle_diameter_mm"];
const TECHNOLOGY = ["required_print_technology"];
const SLICER = ["slicer_print_time_minutes"];

const allowed = (ctx: PieceEditContext, fields: string[]) =>
  assert.equal(pieceSpecEditRefusal(ctx, fields), null);
const refused = (ctx: PieceEditContext, fields: string[], match: RegExp) => {
  const r = pieceSpecEditRefusal(ctx, fields);
  assert.ok(r, "expected a refusal");
  assert.match(r!.message, match);
};

// ── The change: colour and material stay editable through 'ready' ───────────

test("colour and material are editable at every status up to 'scheduled'", () => {
  for (const status of ["pending", "assigned", "ready"]) {
    allowed(piece({ status }), COLOUR);
    allowed(piece({ status }), MATERIAL);
    allowed(piece({ status }), [...COLOUR, ...MATERIAL]);
  }
});

test("colour and material are frozen from 'scheduled' onward", () => {
  for (const status of ["scheduled", "printing", "done", "failed", "cancelled"]) {
    refused(piece({ status }), COLOUR, /scheduled/i);
    refused(piece({ status }), MATERIAL, /scheduled/i);
  }
});

// ── What did NOT move: the machine half of the spec ─────────────────────────

test("the machine spec still locks at 'ready' — the assignment was chosen to match it", () => {
  // A ready piece has an assigned printer and nozzle. Letting the technology or
  // the nozzle move would leave the assignment describing a machine that cannot
  // do the job, with nothing to re-check it.
  for (const status of ["ready", "scheduled", "printing", "done", "failed", "cancelled"]) {
    refused(piece({ status }), NOZZLE, /ready for production/i);
    refused(piece({ status }), TECHNOLOGY, /ready for production/i);
    refused(piece({ status }), ["required_nozzle_material"], /ready for production/i);
    refused(piece({ status }), ["requires_multicolor"], /ready for production/i);
    refused(piece({ status }), ["required_multicolor_capable"], /ready for production/i);
    refused(piece({ status }), ["stl_file_url"], /ready for production/i);
  }
});

test("the machine spec is still editable before 'ready'", () => {
  for (const status of ["pending", "assigned"]) {
    allowed(piece({ status }), NOZZLE);
    allowed(piece({ status }), TECHNOLOGY);
  }
});

test("a patch mixing colour with a locked tech field is refused whole", () => {
  // The looser rule must not launder the stricter one: sending the nozzle
  // alongside the colour has to be refused, not partly applied.
  refused(piece({ status: "ready" }), [...COLOUR, ...NOZZLE], /ready for production/i);
});

test("slicer fields are unaffected by the change", () => {
  allowed(piece({ status: "ready" }), SLICER);
  refused(piece({ status: "scheduled" }), SLICER, /scheduled/i);
});

// ── The plate guard ─────────────────────────────────────────────────────────

test("a piece on a plate does NOT get the extra status of leeway", () => {
  // The plate carries its own filament and reserves its own spool, so a member
  // whose colour moved would state a requirement its plate cannot satisfy.
  refused(piece({ status: "ready", bed_id: "bed-1" }), COLOUR, /plate/i);
  refused(piece({ status: "ready", bed_id: "bed-1" }), MATERIAL, /plate/i);
});

test("a bedded piece keeps EXACTLY the access it had before 'ready'", () => {
  // The whole change is additive. Joining a bed resets a piece to 'pending',
  // where editing its colour works today — taking that away would be a change
  // nobody asked for, so the plate rule only declines to WIDEN the window.
  for (const status of ["pending", "assigned"]) {
    allowed(piece({ status, bed_id: "bed-1" }), COLOUR);
    allowed(piece({ status, bed_id: "bed-1" }), MATERIAL);
  }
  // …and it is still refused past 'ready', by the same rule as an unbedded one.
  refused(piece({ status: "scheduled", bed_id: "bed-1" }), COLOUR, /plate|scheduled/i);
});

test("a piece NOT on a plate is unaffected, including when bed_id is absent entirely", () => {
  // The column ships with the print_beds migration and is never named in SQL,
  // so an un-migrated deploy has no field at all. That must read as "not on a
  // plate", not as an error.
  allowed(piece({ status: "ready", bed_id: null }), COLOUR);
  const noBedField = { status: "ready", order_status: "in_production" } as PieceEditContext;
  allowed(noBedField, COLOUR);
});

test("the plate guard does not block edits that were already allowed", () => {
  allowed(piece({ status: "pending", bed_id: "bed-1" }), ["notes" as string]);
});

test("EVERY combination that was refused before is still refused", () => {
  // The exhaustive guard on "break nothing": replay the pre-change rules over
  // the whole status × field grid and assert the only cells that moved are the
  // two material-spec fields at 'ready' on a piece that is not on a plate.
  const STATUSES = ["pending", "assigned", "ready", "scheduled", "printing", "done", "failed", "cancelled"];
  const TECH_LOCKED = new Set(["ready", "scheduled", "printing", "done", "failed", "cancelled"]);
  const moved: string[] = [];
  for (const status of STATUSES) {
    for (const bed of [null, "bed-1"]) {
      for (const field of TECH_FIELDS) {
        const before = TECH_LOCKED.has(status); // the old rule: one lock for all tech fields
        const after = pieceSpecEditRefusal(piece({ status, bed_id: bed }), [field]) !== null;
        if (before !== after) moved.push(`${status}/${bed ?? "no-bed"}/${field}: ${before}→${after}`);
      }
    }
  }
  assert.deepEqual(moved, [
    "ready/no-bed/required_filament_material: true→false",
    "ready/no-bed/required_color: true→false"
  ]);
});

// ── The order-level lock still wins ─────────────────────────────────────────

test("an order that has left production freezes the whole spec, colour included", () => {
  for (const order_status of ["ready_for_shipping", "out_for_shipping", "returned", "fulfilled"]) {
    refused(piece({ status: "pending", order_status }), COLOUR, /left production/i);
    refused(piece({ status: "pending", order_status }), SLICER, /left production/i);
  }
});

test("completed and cancelled orders are deliberately NOT order-level locked", () => {
  // Their pieces are already done/cancelled, so the per-piece lock covers them —
  // this is pre-existing behaviour and must not change.
  refused(piece({ status: "done", order_status: "completed" }), COLOUR, /scheduled/i);
});

// ── Nothing else is affected ────────────────────────────────────────────────

test("a patch touching no specification field is always allowed", () => {
  for (const status of ["pending", "ready", "scheduled", "printing", "done"]) {
    allowed(piece({ status }), ["piece_name", "notes", "cost", "cost_inputs"]);
  }
  allowed(piece({ status: "done", order_status: "fulfilled" }), ["notes"]);
});

test("an empty patch is allowed", () => {
  allowed(piece({ status: "scheduled" }), []);
});

test("MATERIAL_SPEC_FIELDS is a strict subset of TECH_FIELDS", () => {
  // If one drifts out of the other, a field would end up with no lock at all.
  for (const f of MATERIAL_SPEC_FIELDS) {
    assert.ok((TECH_FIELDS as readonly string[]).includes(f), `${f} must be a tech field`);
  }
  assert.ok(MATERIAL_SPEC_FIELDS.length < TECH_FIELDS.length);
});
