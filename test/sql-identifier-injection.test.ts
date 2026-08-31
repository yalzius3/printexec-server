import assert from "node:assert/strict";
import { test } from "node:test";

import { buildUpdateClause } from "../src/common/sql.ts";
import { updateOrderSchema } from "../src/orders/orders.schemas.ts";
import { updateCustomerSchema } from "../src/customers/customers.schemas.ts";

// ════════════════════════════════════════════════════════════════
// The one property the UPDATE path's safety rests on.
//
// buildUpdateClause splices the OBJECT KEY straight into SQL:
//
//     assignments = entries.map(([column], i) => `${column} = $${i + start}`)
//
// A column name is an identifier, so it cannot be a bound parameter — there is
// no safe way to parameterise it. That makes every caller's key set the entire
// defence, and every caller feeds it a Zod-parsed object.
//
// So the whole argument reduces to: "z.object() strips keys it does not
// declare". That is true of Zod 4 by default, and there is no .passthrough(),
// .catchall(), .looseObject() or z.record() anywhere in this codebase — but it
// is a documented default, not a compiler guarantee, and a single
// .passthrough() added in future would silently turn buildUpdateClause into
// arbitrary SQL injection with nothing failing.
//
// These tests make that default an executable guarantee instead of a comment.
// ════════════════════════════════════════════════════════════════

/** Keys shaped like an attempt to break out of the identifier position. */
const INJECTION_KEYS = [
  "status = 'cancelled', company_id",
  "title, deleted_at = now(), title",
  "notes = (SELECT password FROM auth.users LIMIT 1), notes",
  "title\"",
  "title; DROP TABLE orders; --",
  "title) VALUES (1); --",
  "1=1",
  "*",
  "company_id",
  "__proto__",
  "constructor",
];

test("updateOrderSchema strips every injection-shaped key", () => {
  const hostile: Record<string, unknown> = { title: "a legitimate title" };
  for (const k of INJECTION_KEYS) hostile[k] = "payload";

  const parsed = updateOrderSchema.parse(hostile) as Record<string, unknown>;

  for (const k of INJECTION_KEYS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(parsed, k),
      false,
      `key ${JSON.stringify(k)} survived parsing and would enter SQL as an identifier`
    );
  }
  assert.equal(parsed.title, "a legitimate title", "declared keys must still pass");
});

test("updateCustomerSchema strips every injection-shaped key", () => {
  // One real field is required: this schema refines to "at least one field",
  // and with only hostile keys the parse fails BECAUSE they were all stripped.
  // That failure is itself the property under test — this asserts it directly.
  const onlyHostile: Record<string, unknown> = {};
  for (const k of INJECTION_KEYS) onlyHostile[k] = "payload";
  assert.equal(
    updateCustomerSchema.safeParse(onlyHostile).success,
    false,
    "a body of nothing but undeclared keys must parse to {} and be rejected"
  );

  const hostile: Record<string, unknown> = { city: "Cairo" };
  for (const k of INJECTION_KEYS) hostile[k] = "payload";

  const parsed = updateCustomerSchema.parse(hostile) as Record<string, unknown>;
  for (const k of INJECTION_KEYS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(parsed, k),
      false,
      `key ${JSON.stringify(k)} survived parsing`
    );
  }
});

test("end to end: a hostile body cannot reach the SQL text", () => {
  // Exactly the production path: raw body -> schema -> buildUpdateClause.
  const body = {
    title: "ok",
    "status = 'cancelled', company_id": "'00000000-0000-0000-0000-000000000000'",
    "notes = (SELECT 1), notes": "x",
  };
  const parsed = updateOrderSchema.parse(body) as Record<string, unknown>;
  const { clause, values } = buildUpdateClause(parsed);

  assert.equal(clause, "title = $1", "only the declared column may appear");
  assert.deepEqual(values, ["ok"]);
  assert.equal(clause.includes("company_id"), false);
  assert.equal(clause.includes("SELECT"), false);
  assert.equal(clause.includes(";"), false);
});

test("buildUpdateClause is UNSAFE on its own — it trusts its caller entirely", () => {
  // Not a defect being reported: it is the documented contract. This test pins
  // the contract so nobody later mistakes the function for one that sanitises,
  // and so the reason every caller MUST pass a parsed object is discoverable
  // from the test suite rather than only from a comment.
  const { clause } = buildUpdateClause({ "a = 1, b": "x" });
  assert.equal(
    clause,
    "a = 1, b = $1",
    "an unparsed key reaches the statement verbatim — callers must parse first"
  );
});

test("undefined values are dropped, so an absent field cannot null a column", () => {
  const { clause, values } = buildUpdateClause({ title: "t", notes: undefined });
  assert.equal(clause, "title = $1");
  assert.deepEqual(values, ["t"]);
});

test("an all-undefined patch produces no clause rather than broken SQL", () => {
  const { clause, values } = buildUpdateClause({ a: undefined, b: undefined });
  assert.equal(clause, "");
  assert.deepEqual(values, []);
});
