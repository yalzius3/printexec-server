// Pure unit tests for the order-number format helpers. No database required —
// these always run (`npm run test:unit`) and cover the TENANT_CODE / YEAR /
// SEQUENCE formatting rules from the spec.
//
// Run: node --test "test/tenant-code.test.ts"   (see package.json scripts)

import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveTenantCodeBase,
  padOrderSequence,
  formatOrderNumber,
  TENANT_CODE_FALLBACK,
} from "../src/common/tenant-code.ts";

test("deriveTenantCodeBase: first three letters, upper-cased", () => {
  assert.equal(deriveTenantCodeBase("ABC Company"), "ABC");
  assert.equal(deriveTenantCodeBase("Acme Widgets"), "ACM");
  assert.equal(deriveTenantCodeBase("xyz"), "XYZ");
});

test("deriveTenantCodeBase: spaces and non-letters stripped before slicing", () => {
  // "3D Printing Co" -> letters only "DPrintingCo" -> "DPR"
  assert.equal(deriveTenantCodeBase("3D Printing Co"), "DPR");
  assert.equal(deriveTenantCodeBase("  Zeta  Labs "), "ZET");
  assert.equal(deriveTenantCodeBase("A.B.C. Corp"), "ABC");
  assert.equal(deriveTenantCodeBase("7-Eleven"), "ELE");
});

test("deriveTenantCodeBase: fewer than three letters uses what's available", () => {
  assert.equal(deriveTenantCodeBase("Ai"), "AI");
  assert.equal(deriveTenantCodeBase("Q"), "Q");
  assert.equal(deriveTenantCodeBase("K2"), "K");
});

test("deriveTenantCodeBase: no usable letters falls back", () => {
  assert.equal(deriveTenantCodeBase("123"), TENANT_CODE_FALLBACK);
  assert.equal(deriveTenantCodeBase("!!!"), TENANT_CODE_FALLBACK);
  assert.equal(deriveTenantCodeBase(""), TENANT_CODE_FALLBACK);
  assert.equal(deriveTenantCodeBase(null), TENANT_CODE_FALLBACK);
  assert.equal(deriveTenantCodeBase(undefined), TENANT_CODE_FALLBACK);
});

test("deriveTenantCodeBase: only ASCII A-Z count (accents are stripped)", () => {
  // Documents the intentional ASCII-only rule: "Île" -> "le" -> "LE".
  assert.equal(deriveTenantCodeBase("Île de France"), "LED");
});

test("padOrderSequence: zero-pads to five digits", () => {
  assert.equal(padOrderSequence(1), "00001");
  assert.equal(padOrderSequence(2), "00002");
  assert.equal(padOrderSequence(42), "00042");
  assert.equal(padOrderSequence(99999), "99999");
});

test("padOrderSequence: widens rather than truncates past five digits", () => {
  assert.equal(padOrderSequence(100000), "100000");
  assert.equal(padOrderSequence(1234567), "1234567");
});

test("formatOrderNumber: matches the spec examples exactly", () => {
  assert.equal(formatOrderNumber("ABC", 2026, 1), "ABC-2026-00001");
  assert.equal(formatOrderNumber("ABC", 2026, 2), "ABC-2026-00002");
  assert.equal(formatOrderNumber("ABC", 2027, 1), "ABC-2027-00001");
  assert.equal(formatOrderNumber("XYZ", 2026, 1), "XYZ-2026-00001");
});

test("formatOrderNumber: accepts a string year (as stored on the order)", () => {
  assert.equal(formatOrderNumber("ABC", "2026", 5), "ABC-2026-00005");
});
