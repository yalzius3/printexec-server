import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeCustomMonthlyUsd,
  describeCustomPlan,
  termsFromRow,
  type CustomPlanTerms
} from "../src/licensing/custom-plan.ts";

// The custom-plan math decides what customers are actually billed, so the
// shapes the admin console can produce are pinned here.

const terms = (over: Partial<CustomPlanTerms> = {}): CustomPlanTerms => ({
  maxPrinters: null,
  priceModel: null,
  priceAmount: null,
  bundleSize: null,
  billingBasis: "cap",
  baseAmount: null,
  includedPrinters: null,
  overageModel: null,
  minMonthly: null,
  label: null,
  note: null,
  ...over
});

test("no pricing model → no custom price (falls back to the plan's list price)", () => {
  assert.equal(computeCustomMonthlyUsd(terms({ maxPrinters: 100 }), 42), null);
  assert.equal(computeCustomMonthlyUsd(null, 42), null);
});

test("flat: a fixed monthly amount, independent of usage and cap", () => {
  const t = terms({ priceModel: "flat", priceAmount: 1500, maxPrinters: 100 });
  assert.equal(computeCustomMonthlyUsd(t, 0), 1500);
  assert.equal(computeCustomMonthlyUsd(t, 250), 1500);
});

test("per-printer on the committed cap: $9.08 x 100 slots", () => {
  const t = terms({ priceModel: "per_printer", priceAmount: 9.08, maxPrinters: 100, billingBasis: "cap" });
  // Bills the slots they bought, not the ones they happen to be running.
  assert.equal(computeCustomMonthlyUsd(t, 63), 908);
  assert.equal(computeCustomMonthlyUsd(t, 0), 908);
});

test("per-printer on actual usage: bills what they run", () => {
  const t = terms({ priceModel: "per_printer", priceAmount: 9.08, maxPrinters: 100, billingBasis: "actual" });
  assert.equal(computeCustomMonthlyUsd(t, 63), 572.04);
  assert.equal(computeCustomMonthlyUsd(t, 0), 0);
});

test("bundle: $69 per 10 printers, rounding partial bundles up", () => {
  const cap = terms({ priceModel: "bundle", priceAmount: 69, bundleSize: 10, maxPrinters: 100, billingBasis: "cap" });
  assert.equal(computeCustomMonthlyUsd(cap, 5), 690); // 10 bundles of committed cap

  const actual = terms({ priceModel: "bundle", priceAmount: 69, bundleSize: 10, billingBasis: "actual" });
  assert.equal(computeCustomMonthlyUsd(actual, 10), 69);
  assert.equal(computeCustomMonthlyUsd(actual, 11), 138); // partial bundle rounds up
  assert.equal(computeCustomMonthlyUsd(actual, 0), 0);
});

test("bundle without a size is unpriceable rather than wrong", () => {
  const t = terms({ priceModel: "bundle", priceAmount: 69, bundleSize: null, billingBasis: "actual" });
  assert.equal(computeCustomMonthlyUsd(t, 10), null);
});

test("cap basis with no cap (unlimited) falls back to actual usage", () => {
  const t = terms({ priceModel: "per_printer", priceAmount: 10, maxPrinters: null, billingBasis: "cap" });
  assert.equal(computeCustomMonthlyUsd(t, 7), 70);
});

test("money is rounded to cents, never negative", () => {
  const t = terms({ priceModel: "per_printer", priceAmount: 9.005, maxPrinters: 3, billingBasis: "cap" });
  assert.equal(computeCustomMonthlyUsd(t, 0), 27.02); // 27.015 → 27.02
  assert.equal(computeCustomMonthlyUsd(terms({ priceModel: "flat", priceAmount: -5 }), 1), null);
});

test("termsFromRow: only a cap, only a price, or neither", () => {
  assert.equal(termsFromRow({}), null);
  assert.equal(termsFromRow(null), null);

  const capOnly = termsFromRow({ custom_max_printers: 100 });
  assert.equal(capOnly?.maxPrinters, 100);
  assert.equal(capOnly?.priceModel, null);
  assert.equal(capOnly?.billingBasis, "cap", "defaults to committed-cap billing");

  // pg hands NUMERIC back as a string — it must survive as a number.
  const priced = termsFromRow({
    custom_price_model: "per_printer",
    custom_price_amount: "9.08",
    custom_billing_basis: "actual"
  });
  assert.equal(priced?.priceAmount, 9.08);
  assert.equal(computeCustomMonthlyUsd(priced, 10), 90.8);
});

// ── base + overage: "$500 covers 50 printers, extras are metered" ──────────

test("base + overage, per printer: base alone until the allowance is exceeded", () => {
  const t = terms({
    priceModel: "base_plus_overage",
    baseAmount: 500,
    includedPrinters: 50,
    overageModel: "per_printer",
    priceAmount: 9.08,
    billingBasis: "actual"
  });
  assert.equal(computeCustomMonthlyUsd(t, 0), 500, "no printers → base only");
  assert.equal(computeCustomMonthlyUsd(t, 50), 500, "exactly the allowance → base only");
  assert.equal(computeCustomMonthlyUsd(t, 51), 509.08, "one over → base + one printer");
  assert.equal(computeCustomMonthlyUsd(t, 60), 590.8, "ten over");
});

test("base + overage, per bundle: extras round up to whole blocks", () => {
  const t = terms({
    priceModel: "base_plus_overage",
    baseAmount: 500,
    includedPrinters: 50,
    overageModel: "bundle",
    priceAmount: 69,
    bundleSize: 10,
    billingBasis: "actual"
  });
  assert.equal(computeCustomMonthlyUsd(t, 50), 500, "at the allowance → base only");
  assert.equal(computeCustomMonthlyUsd(t, 51), 569, "1 over → a whole block of 10");
  assert.equal(computeCustomMonthlyUsd(t, 60), 569, "10 over → still one block");
  assert.equal(computeCustomMonthlyUsd(t, 61), 638, "11 over → two blocks");
});

test("base + overage on the committed cap bills the slots, not usage", () => {
  const t = terms({
    priceModel: "base_plus_overage",
    baseAmount: 500,
    includedPrinters: 50,
    overageModel: "per_printer",
    priceAmount: 10,
    maxPrinters: 60,
    billingBasis: "cap"
  });
  // They committed to 60 slots; 10 of them are beyond the allowance.
  assert.equal(computeCustomMonthlyUsd(t, 0), 600);
  assert.equal(computeCustomMonthlyUsd(t, 55), 600, "usage doesn't change a committed deal");
});

test("base + overage with no overage model is a hard-capped flat base", () => {
  const t = terms({
    priceModel: "base_plus_overage",
    baseAmount: 500,
    includedPrinters: 50,
    overageModel: null,
    billingBasis: "actual"
  });
  assert.equal(computeCustomMonthlyUsd(t, 80), 500, "extras aren't metered");
});

test("base + overage needs a base, and a metered overage needs a rate", () => {
  assert.equal(
    computeCustomMonthlyUsd(terms({ priceModel: "base_plus_overage", baseAmount: null }), 10),
    null
  );
  const noRate = terms({
    priceModel: "base_plus_overage",
    baseAmount: 500,
    includedPrinters: 5,
    overageModel: "per_printer",
    priceAmount: null,
    billingBasis: "actual"
  });
  assert.equal(computeCustomMonthlyUsd(noRate, 10), null, "over the allowance with no rate");
  assert.equal(computeCustomMonthlyUsd(noRate, 3), 500, "under it, the rate is irrelevant");
});

// ── minimum monthly floor (composes with every model) ──────────────────────

test("the minimum floor raises a small month but never discounts a big one", () => {
  const t = terms({
    priceModel: "per_printer",
    priceAmount: 9.08,
    minMonthly: 500,
    billingBasis: "actual"
  });
  assert.equal(computeCustomMonthlyUsd(t, 10), 500, "90.80 → floored to 500");
  assert.equal(computeCustomMonthlyUsd(t, 100), 908, "above the floor, unchanged");

  const withBase = terms({
    priceModel: "base_plus_overage",
    baseAmount: 100,
    includedPrinters: 50,
    overageModel: "per_printer",
    priceAmount: 9.08,
    minMonthly: 250,
    billingBasis: "actual"
  });
  assert.equal(computeCustomMonthlyUsd(withBase, 10), 250, "floor applies to base+overage too");
});

test("describeCustomPlan reads back the deal in plain words", () => {
  assert.equal(
    describeCustomPlan(terms({ priceModel: "per_printer", priceAmount: 9.08, maxPrinters: 100, billingBasis: "cap" }), 63),
    "$9.08 per printer × 100 slots"
  );
  assert.equal(
    describeCustomPlan(terms({ priceModel: "bundle", priceAmount: 69, bundleSize: 10, billingBasis: "actual" }), 11),
    "$69 per 10 printers × 2 (11 in use)"
  );
  assert.equal(describeCustomPlan(terms({ maxPrinters: 100 }), 5), null, "cap-only has no price to describe");

  assert.equal(
    describeCustomPlan(
      terms({
        priceModel: "base_plus_overage",
        baseAmount: 500,
        includedPrinters: 50,
        overageModel: "per_printer",
        priceAmount: 9.08,
        billingBasis: "actual"
      }),
      60
    ),
    "$500 base covers 50 printers + 10 over × $9.08 (60 in use)"
  );

  assert.equal(
    describeCustomPlan(
      terms({ priceModel: "per_printer", priceAmount: 9.08, minMonthly: 500, billingBasis: "actual" }),
      10
    ),
    "$9.08 per printer × 10 in use, min $500"
  );
});
