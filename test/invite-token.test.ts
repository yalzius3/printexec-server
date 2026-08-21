// Pure unit tests for the invite-code kernel. No database required.
//
// The bug these pin: generation emits ABCD-EFGH, redemption did a bare
// `WHERE token = $1`, and the only normalization anywhere was toUpperCase +
// strip-\s on the client. Every separator variant a real person produces —
// omitting the dash, an en-dash pasted out of an email, a zero-width space
// riding along on a copy — was answered "This invite code doesn't exist",
// which is both wrong and the one message guaranteed to make them retype the
// same thing again.
//
// Run: node --test "test/invite-token.test.ts"   (see package.json scripts)

import test from "node:test";
import assert from "node:assert/strict";
import {
  INVITE_CHARSET,
  canonicalizeInviteToken,
  generateInviteToken,
} from "../src/staff/invite-token.ts";

const CANONICAL = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

// ── shape of a minted code ──────────────────────────────────────
test("generated codes are canonical ABCD-EFGH", () => {
  for (let i = 0; i < 500; i++) {
    const t = generateInviteToken();
    assert.equal(t.length, 9, `bad length for ${t}`);
    assert.match(t, CANONICAL, `not canonical: ${t}`);
    assert.equal(t[4], "-");
  }
});

test("generated codes never contain the four excluded glyphs", () => {
  for (let i = 0; i < 500; i++) {
    const body = generateInviteToken().replace("-", "");
    for (const ch of body) {
      assert.ok(INVITE_CHARSET.includes(ch), `${ch} is not in the charset`);
    }
  }
});

// ── the round trip that has to hold forever ─────────────────────
test("canonicalize(generate()) is the identity", () => {
  for (let i = 0; i < 500; i++) {
    const t = generateInviteToken();
    assert.equal(canonicalizeInviteToken(t), t);
  }
});

// ── the eleven entries that used to 404 ─────────────────────────
const STORED = "K7QM-4XPB";

const ACCEPTED: Array<[string, string]> = [
  ["exactly as shown", "K7QM-4XPB"],
  ["lowercase", "k7qm-4xpb"],
  ["surrounding spaces", "  K7QM-4XPB  "],
  ["non-breaking space around it", " K7QM-4XPB "],
  ["no dash at all", "K7QM4XPB"],
  ["space instead of the dash", "K7QM 4XPB"],
  ["underscore instead of the dash", "K7QM_4XPB"],
  ["en-dash", "K7QM–4XPB"],
  ["em-dash", "K7QM—4XPB"],
  ["non-breaking hyphen", "K7QM‑4XPB"],
  ["figure dash", "K7QM‒4XPB"],
  ["horizontal bar", "K7QM―4XPB"],
  ["minus sign", "K7QM−4XPB"],
  ["zero-width space trailing", "K7QM-4XPB​"],
  ["LTR mark leading (RTL mail client)", "‎K7QM-4XPB"],
  ["RTL mark leading", "‏K7QM-4XPB"],
  ["word joiner inside", "K7QM⁠-4XPB"],
  ["BOM leading", "﻿K7QM-4XPB"],
  ["lowercase, no dash, padded", "  k7qm4xpb "],
  ["tab instead of the dash", "K7QM\t4XPB"],
  ["newline inside", "K7QM-\n4XPB"],
];

for (const [label, entered] of ACCEPTED) {
  test(`accepts: ${label}`, () => {
    assert.equal(canonicalizeInviteToken(entered), STORED);
  });
}

// ── fails closed ────────────────────────────────────────────────
const REJECTED: Array<[string, string]> = [
  ["empty", ""],
  ["whitespace only", "   "],
  ["too short", "K7QM-4XP"],
  ["too long", "K7QM-4XPBB"],
  ["contains excluded I", "K7QI-4XPB"],
  ["contains excluded O", "K7QO-4XPB"],
  ["contains excluded 0", "K7Q0-4XPB"],
  ["contains excluded 1", "K7Q1-4XPB"],
  ["contains punctuation", "K7QM-4XP!"],
  ["separators only", "--------"],
  ["a sentence", "my invite code is K7QM-4XPB thanks"],
];

for (const [label, entered] of REJECTED) {
  test(`rejects: ${label}`, () => {
    assert.equal(canonicalizeInviteToken(entered), "");
  });
}

// ── the property that makes this safe to ship ───────────────────
// Canonicalization must never WIDEN the match set. If it folded look-alike
// glyphs (O->0, 5->S, 2->Z) two different live codes would share one lookup
// key, and redeeming one could hand you the other company's workspace.
test("look-alike glyphs are NOT folded into each other", () => {
  const pairs = [
    ["2", "Z"],
    ["5", "S"],
    ["8", "B"],
    ["6", "G"],
  ];
  for (const [digit, letter] of pairs) {
    const a = canonicalizeInviteToken(`${digit}QMK-4XPB`);
    const b = canonicalizeInviteToken(`${letter}QMK-4XPB`);
    assert.notEqual(a, "", `${digit} should be a valid code character`);
    assert.notEqual(b, "", `${letter} should be a valid code character`);
    assert.notEqual(a, b, `${digit} and ${letter} must not canonicalize alike`);
  }
});

test("canonicalization is injective over minted codes", () => {
  const seen = new Map<string, string>();
  for (let i = 0; i < 5000; i++) {
    const t = generateInviteToken();
    const key = canonicalizeInviteToken(t);
    const prior = seen.get(key);
    // Same key must only ever come from the identical token.
    if (prior !== undefined) assert.equal(prior, t);
    seen.set(key, t);
  }
});

test("no separator character is a member of the charset", () => {
  // The reason stripping separators cannot collide two real codes.
  for (const ch of " -_ ​‎–—−﻿\t\n") {
    assert.ok(
      !INVITE_CHARSET.includes(ch),
      `${JSON.stringify(ch)} is both a separator and a code character`
    );
  }
});
