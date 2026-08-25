// Guards the ONE property that decides whether a staff invite can be redeemed
// at all: inside the redemption transaction, the users row must be INSERTed
// before company_invites.used_by is written.
//
// company_invites.used_by is a foreign key onto users(id). Writing the claim
// first therefore raises 23503 foreign_key_violation on EVERY redemption, the
// transaction rolls back, and the invite stays unused and still listed in the
// owner's window while the invitee is told the request "references a record
// that does not exist". That is exactly what production did.
//
// Why this test reads the source instead of calling the controller:
// AuthController is a Nest class using parameter properties, which node's
// strip-only type stripping cannot execute — the same constraint that forced
// the resin matching kernel out into a plain module. The behaviour is proven
// against a real Postgres in invite-redemption.integration.test.ts; this test
// exists so the ordering cannot be quietly reversed by a later refactor while
// that suite is skipped (it needs TEST_DATABASE_URL and does not run by
// default). The comment above the transaction says the order is load-bearing;
// this makes that enforceable rather than advisory.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "src", "auth", "auth.controller.ts"), "utf8");

/** The staff redemption's users INSERT — 'staff' distinguishes it from the owner path. */
const USERS_INSERT = "VALUES ($1, $2, $3, $4, 'staff', $5)";
/** The compare-and-set claim that stamps used_by. */
const INVITE_CLAIM = "UPDATE company_invites SET used_at = now(), used_by = $1";

describe("invite redemption statement order", () => {
  it("has exactly one staff users INSERT and one invite claim to reason about", () => {
    assert.equal(
      source.split(USERS_INSERT).length - 1,
      1,
      "expected a single staff users INSERT; update this test if the redemption path was restructured"
    );
    assert.equal(
      source.split(INVITE_CLAIM).length - 1,
      1,
      "expected a single used_by claim; update this test if the redemption path was restructured"
    );
  });

  it("inserts the users row BEFORE stamping company_invites.used_by", () => {
    const insertAt = source.indexOf(USERS_INSERT);
    const claimAt = source.indexOf(INVITE_CLAIM);

    assert.notEqual(insertAt, -1, "staff users INSERT not found");
    assert.notEqual(claimAt, -1, "invite claim not found");
    assert.ok(
      insertAt < claimAt,
      "company_invites.used_by is a foreign key onto users(id): claiming the invite " +
        "before inserting the users row makes every redemption fail with 23503"
    );
  });

  it("keeps both statements inside one transaction, which is what makes the order safe", () => {
    // Claiming after the insert is only safe because a racer that loses the
    // compare-and-set rolls its own users row back. That requires both
    // statements to share the transaction — so both must be passed `client`.
    const tx = source.slice(
      source.indexOf("await this.db.transaction", source.lastIndexOf("const emptyPerms", source.indexOf(USERS_INSERT)))
    );
    const body = tx.slice(0, tx.indexOf("\n    });") + 1);

    assert.ok(body.includes(USERS_INSERT), "users INSERT must be inside the transaction");
    assert.ok(body.includes(INVITE_CLAIM), "invite claim must be inside the transaction");

    const afterInsert = body.slice(body.indexOf(USERS_INSERT), body.indexOf(INVITE_CLAIM));
    assert.ok(
      afterInsert.includes("client"),
      "the users INSERT must run on the transaction's client, not the pool"
    );
  });
});
