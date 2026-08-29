import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateThrottle } from "../src/common/throttle-window.ts";

const OPTS = { limit: 3, windowMs: 60_000 };

// ── The budget itself ───────────────────────────────────────────────────────

test("requests up to the limit are allowed", () => {
  let hits: number[] = [];
  for (let i = 1; i <= OPTS.limit; i++) {
    const d = evaluateThrottle(hits, 1_000 + i, OPTS);
    assert.equal(d.allowed, true, `request ${i} should pass`);
    hits = d.hits;
  }
  assert.equal(hits.length, 3);
});

test("the request one past the limit is blocked", () => {
  const hits = [1_001, 1_002, 1_003];
  const d = evaluateThrottle(hits, 1_004, OPTS);
  assert.equal(d.allowed, false);
});

test("a blocked request does NOT extend its own penalty", () => {
  // The bug this guards against: recording the rejected attempt would push the
  // window forward on every retry, so a client hammering the endpoint could
  // never recover. The surviving window must come back unchanged.
  const hits = [1_001, 1_002, 1_003];
  const d = evaluateThrottle(hits, 1_004, OPTS);
  assert.equal(d.allowed, false);
  assert.deepEqual(d.hits, hits);
});

// ── Ageing out ──────────────────────────────────────────────────────────────

test("hits older than the window are dropped, freeing the slot", () => {
  const hits = [1_000, 2_000, 3_000];
  // 3_000 + windowMs → the first two have aged out, the third is exactly at
  // the boundary and has also served its time.
  const d = evaluateThrottle(hits, 3_000 + OPTS.windowMs, OPTS);
  assert.equal(d.allowed, true);
  assert.deepEqual(d.hits, [3_000 + OPTS.windowMs]);
});

test("a hit exactly windowMs old has served its time (boundary is exclusive)", () => {
  const d = evaluateThrottle([0], OPTS.windowMs, { limit: 1, windowMs: OPTS.windowMs });
  assert.equal(d.allowed, true, "exactly-expired hit must not count");
});

test("a hit one ms short of the window still counts", () => {
  const d = evaluateThrottle([0], OPTS.windowMs - 1, { limit: 1, windowMs: OPTS.windowMs });
  assert.equal(d.allowed, false, "not yet expired, so it must still block");
});

// ── Retry-After ─────────────────────────────────────────────────────────────

test("retryAfterSec counts from the OLDEST live hit", () => {
  // Oldest is at 1_000, window 60s, now 31_000 → 30s of the window remain.
  const d = evaluateThrottle([1_000, 2_000, 3_000], 31_000, OPTS);
  assert.equal(d.allowed, false);
  assert.equal(d.retryAfterSec, 30);
});

test("retryAfterSec is never 0 — a sub-second wait rounds up to 1", () => {
  // 500ms left. Advertising "0" tells a client to retry immediately.
  const d = evaluateThrottle([1_000, 2_000, 3_000], 60_500, OPTS);
  assert.equal(d.allowed, false);
  assert.equal(d.retryAfterSec, 1);
});

test("retryAfterSec rounds up, never down", () => {
  // 1_500ms remaining must advertise 2s, not 1s — under-advertising invites a
  // retry that is itself rejected.
  const d = evaluateThrottle([1_000, 2_000, 3_000], 59_500, OPTS);
  assert.equal(d.retryAfterSec, 2);
});

// ── Degenerate inputs ───────────────────────────────────────────────────────

test("an empty history always allows", () => {
  const d = evaluateThrottle([], 12_345, OPTS);
  assert.equal(d.allowed, true);
  assert.deepEqual(d.hits, [12_345]);
});

test("a limit below 1 still allows the first request", () => {
  // A limit of 0 would otherwise block everything forever, which is never what
  // a caller means by "rate limit this".
  for (const limit of [0, -5]) {
    const d = evaluateThrottle([], 1_000, { limit, windowMs: 60_000 });
    assert.equal(d.allowed, true, `limit ${limit}`);
  }
});

// ── The configured production budgets ───────────────────────────────────────

test("the admin console budget does not fire for human-paced use", () => {
  // 300/min. Opening the admin area fires a handful of requests; simulate a
  // generous 60 and assert none is rejected.
  const opts = { limit: 300, windowMs: 60_000 };
  let hits: number[] = [];
  for (let i = 0; i < 60; i++) {
    const d = evaluateThrottle(hits, 1_000 + i * 50, opts);
    assert.equal(d.allowed, true, `console request ${i} must not be throttled`);
    hits = d.hits;
  }
});

test("the unlock budget outlasts the 5-failure lockout it sits beside", () => {
  // AdminSessionService locks out after 5 FAILED attempts. This throttle is
  // 10 per 5 minutes, so a real admin mistyping the passphrase always meets
  // the clear lockout message first, never an opaque 429.
  const opts = { limit: 10, windowMs: 5 * 60_000 };
  let hits: number[] = [];
  for (let i = 0; i < 5; i++) {
    const d = evaluateThrottle(hits, 1_000 + i * 2_000, opts);
    assert.equal(d.allowed, true, `unlock attempt ${i + 1} must reach the lockout logic`);
    hits = d.hits;
  }
});
