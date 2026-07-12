// Unit tests for the shared costing formula evaluator. This is the one piece of
// math that prices both the quoted Total and the invoice, so it is worth pinning
// hard: operator precedence, parentheses, safe division-by-zero, the default
// formula's equivalence to the legacy base×(1+margin), and save-time validation.
//
// Pure (no DB) — runs anywhere: node --test "test/costing-formula.test.ts"

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  evaluate,
  safeEvaluate,
  validateFormula,
  DEFAULT_FORMULA,
  LEGACY_FORMULA,
  type CostingSymbols
} from "../src/orders/costing-formula.ts";

const S = (over: Partial<CostingSymbols> = {}): CostingSymbols => ({
  base: 0,
  material: 0,
  electricity: 0,
  labor: 0,
  variables: 0,
  custom: 0,
  margin: 0,
  orders_per_month: 1,
  ...over
});

describe("costing formula evaluator", () => {
  it("applies * / before + -", () => {
    assert.equal(evaluate("base + variables * 2", S({ base: 10, variables: 5 })), 20);
    assert.equal(evaluate("base - variables / 2", S({ base: 10, variables: 6 })), 7);
  });

  it("honours parentheses", () => {
    assert.equal(evaluate("(base + variables) * 2", S({ base: 10, variables: 5 })), 30);
  });

  it("supports unary minus", () => {
    assert.equal(evaluate("base - -5", S({ base: 10 })), 15);
    assert.equal(evaluate("-base + 3", S({ base: 10 })), -7);
  });

  it("treats division by zero as 0 (never Infinity/NaN)", () => {
    assert.equal(evaluate("variables / orders_per_month", S({ variables: 100, orders_per_month: 0 })), 0);
    assert.equal(evaluate("variables / 0", S({ variables: 100 })), 0);
  });

  it("prices the worked case: variables ÷ orders/mo × (1+margin) + material", () => {
    // 2000 / 50 = 40; × 1.3 = 52; + 60 = 112
    const got = evaluate("variables / orders_per_month * (1 + margin) + material", S({
      variables: 2000,
      orders_per_month: 50,
      margin: 0.3,
      material: 60
    }));
    assert.equal(got, 112);
  });

  it("DEFAULT_FORMULA with an empty config == legacy base×(1+margin)", () => {
    const sym = S({ base: 137.5, margin: 0.42, variables: 0, custom: 0 });
    assert.equal(evaluate(DEFAULT_FORMULA, sym), evaluate(LEGACY_FORMULA, sym));
    assert.equal(evaluate(DEFAULT_FORMULA, sym), 137.5 * 1.42);
  });

  it("DEFAULT_FORMULA folds variables and custom in", () => {
    // (100 + 50) * 1.2 + 25 = 205
    assert.equal(
      evaluate(DEFAULT_FORMULA, S({ base: 100, variables: 50, custom: 25, margin: 0.2 })),
      205
    );
  });

  it("validates good formulas and rejects unknown symbols / bad syntax", () => {
    assert.equal(validateFormula("(base + variables) * (1 + margin)").ok, true);
    assert.equal(validateFormula("base + profit").ok, false); // unknown symbol
    assert.equal(validateFormula("base + * 2").ok, false); // syntax error
    assert.equal(validateFormula("base + (variables").ok, false); // unbalanced
    assert.equal(validateFormula("").ok, false); // empty
  });

  it("safeEvaluate returns null on a bad formula, a number on a good one", () => {
    assert.equal(safeEvaluate("base + nonsense", S({ base: 1 })), null);
    assert.equal(safeEvaluate("base + 2", S({ base: 1 })), 3);
  });

  it("is case-insensitive on identifiers", () => {
    assert.equal(evaluate("BASE + Variables", S({ base: 2, variables: 3 })), 5);
  });
});
