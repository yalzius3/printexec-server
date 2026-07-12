// ── Shared safe formula evaluator for costing presets ────────────────────────
// Mirrored VERBATIM in printexec-client/src/costing-formula.ts and
// printexec-server/src/orders/costing-formula.ts. Keep the two in lockstep: the
// Orders pricing bar and the generated invoice both price an order by evaluating
// the SAME preset formula through this code, so the quoted Total and the invoiced
// total can never diverge (the same reason costing.ts mirrors order-costing.ts).
//
// A preset is a plain arithmetic expression over a fixed set of named symbols:
//   expr    := term  (('+' | '-') term)*
//   term    := unary (('*' | '/') unary)*
//   unary   := ('+' | '-') unary | primary
//   primary := NUMBER | IDENT | '(' expr ')'
// No function calls, no member access, NO eval() — just numbers, whitelisted
// identifiers, four operators and parentheses. Division by zero yields 0 (this is
// a money context: never let Infinity/NaN leak into a price).

export type CostingSymbols = Record<string, number>;

// The identifiers a preset formula may reference. The order-pricing layer builds
// a value for each of these per order before evaluating.
export const COSTING_SYMBOLS = [
  "base", // full per-order base cost (COGS) — untouched
  "material", // Σ filament/material cost across pieces
  "electricity", // Σ electricity cost across pieces
  "labor", // order labour (already folded into base)
  "variables", // Σ selected Finance costing variables
  "custom", // Σ per-order custom cost lines
  "margin", // profit margin as a fraction (0.30 = 30%)
  "orders_per_month" // Finance constant (a safe divisor, never 0 at eval)
] as const;

export type CostingSymbol = (typeof COSTING_SYMBOLS)[number];

// Short, human-facing descriptions for the guided formula builder in Finance.
export const COSTING_SYMBOL_HELP: Record<CostingSymbol, string> = {
  base: "Full production cost of the order (material + electricity + labour).",
  material: "Filament / material cost across all pieces.",
  electricity: "Electricity cost across all pieces.",
  labor: "The order's labour cost.",
  variables: "Sum of the Finance costing variables the order has selected.",
  custom: "Sum of ad-hoc custom charges added to the order.",
  margin: "Profit margin as a fraction — 30% is 0.30. Use (1 + margin).",
  orders_per_month: "Your average orders per month, for spreading a cost."
};

// ── AST ──────────────────────────────────────────────────────────────────────
type Node =
  | { k: "num"; v: number }
  | { k: "id"; v: string }
  | { k: "neg"; e: Node }
  | { k: "bin"; op: "+" | "-" | "*" | "/"; l: Node; r: Node };

type Tok =
  | { t: "num"; v: number }
  | { t: "id"; v: string }
  | { t: "op"; v: "+" | "-" | "*" | "/" | "(" | ")" };

class FormulaSyntaxError extends Error {}

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i += 1;
      continue;
    }
    if (c === "+" || c === "-" || c === "*" || c === "/" || c === "(" || c === ")") {
      toks.push({ t: "op", v: c });
      i += 1;
      continue;
    }
    if ((c >= "0" && c <= "9") || c === ".") {
      let j = i + 1;
      while (j < src.length && ((src[j]! >= "0" && src[j]! <= "9") || src[j]! === ".")) j += 1;
      const raw = src.slice(i, j);
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new FormulaSyntaxError(`Invalid number "${raw}".`);
      toks.push({ t: "num", v: n });
      i = j;
      continue;
    }
    if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_") {
      let j = i + 1;
      while (j < src.length) {
        const d = src[j]!;
        if ((d >= "a" && d <= "z") || (d >= "A" && d <= "Z") || (d >= "0" && d <= "9") || d === "_") j += 1;
        else break;
      }
      toks.push({ t: "id", v: src.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    throw new FormulaSyntaxError(`Unexpected character "${c}".`);
  }
  return toks;
}

// Recursive-descent parse of the token list into an AST.
function parse(src: string): Node {
  const toks = tokenize(src);
  if (toks.length === 0) throw new FormulaSyntaxError("Formula is empty.");
  let pos = 0;
  const peek = (): Tok | undefined => toks[pos];
  const eat = (): Tok => {
    const t = toks[pos];
    if (!t) throw new FormulaSyntaxError("Unexpected end of formula.");
    pos += 1;
    return t;
  };

  const parseExpr = (): Node => {
    let left = parseTerm();
    for (;;) {
      const t = peek();
      if (t && t.t === "op" && (t.v === "+" || t.v === "-")) {
        eat();
        left = { k: "bin", op: t.v, l: left, r: parseTerm() };
      } else break;
    }
    return left;
  };
  const parseTerm = (): Node => {
    let left = parseUnary();
    for (;;) {
      const t = peek();
      if (t && t.t === "op" && (t.v === "*" || t.v === "/")) {
        eat();
        left = { k: "bin", op: t.v, l: left, r: parseUnary() };
      } else break;
    }
    return left;
  };
  const parseUnary = (): Node => {
    const t = peek();
    if (t && t.t === "op" && (t.v === "+" || t.v === "-")) {
      eat();
      const e = parseUnary();
      return t.v === "-" ? { k: "neg", e } : e;
    }
    return parsePrimary();
  };
  const parsePrimary = (): Node => {
    const t = eat();
    if (t.t === "num") return { k: "num", v: t.v };
    if (t.t === "id") return { k: "id", v: t.v };
    if (t.v === "(") {
      const e = parseExpr();
      const close = eat();
      if (!(close.t === "op" && close.v === ")")) throw new FormulaSyntaxError("Expected ')'.");
      return e;
    }
    throw new FormulaSyntaxError(`Unexpected "${t.v}".`);
  };

  const node = parseExpr();
  if (pos !== toks.length) throw new FormulaSyntaxError("Unexpected trailing tokens.");
  return node;
}

function evalNode(n: Node, sym: CostingSymbols): number {
  if (n.k === "num") return n.v;
  if (n.k === "id") {
    const v = sym[n.v];
    if (v === undefined) throw new FormulaSyntaxError(`Unknown symbol "${n.v}".`);
    return v;
  }
  if (n.k === "neg") return -evalNode(n.e, sym);
  const l = evalNode(n.l, sym);
  const r = evalNode(n.r, sym);
  if (n.op === "+") return l + r;
  if (n.op === "-") return l - r;
  if (n.op === "*") return l * r;
  return r === 0 ? 0 : l / r; // "/"
}

// Evaluate a formula against a symbol table. Throws on syntax errors or unknown
// symbols; callers that must not fail should catch or use safeEvaluate.
export function evaluate(formula: string, symbols: CostingSymbols): number {
  const result = evalNode(parse(formula), symbols);
  return Number.isFinite(result) ? result : 0;
}

// Non-throwing variant for live UI previews: returns null on any problem.
export function safeEvaluate(formula: string, symbols: CostingSymbols): number | null {
  try {
    const r = evaluate(formula, symbols);
    return Number.isFinite(r) ? r : null;
  } catch {
    return null;
  }
}

// Validate a formula at save time: it must parse and reference only allowed
// identifiers. Returns a friendly error string when invalid.
export function validateFormula(
  formula: string,
  allowed: readonly string[] = COSTING_SYMBOLS
): { ok: true } | { ok: false; error: string } {
  let node: Node;
  try {
    node = parse(formula);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Invalid formula." };
  }
  const allow = new Set(allowed);
  const bad = new Set<string>();
  const walk = (n: Node): void => {
    if (n.k === "id") {
      if (!allow.has(n.v)) bad.add(n.v);
    } else if (n.k === "neg") walk(n.e);
    else if (n.k === "bin") {
      walk(n.l);
      walk(n.r);
    }
  };
  walk(node);
  if (bad.size > 0) {
    return { ok: false, error: `Unknown ${bad.size > 1 ? "symbols" : "symbol"}: ${[...bad].join(", ")}.` };
  }
  return { ok: true };
}

// The formula an order uses when it has no named preset. With an empty config it
// reduces to base × (1 + margin) — today's exact math — so existing orders
// re-price unchanged. Shared so the client bar and the server invoice agree.
export const DEFAULT_FORMULA = "(base + variables) * (1 + margin) + custom";

// The barest legacy fallback, base × (1 + margin). Kept for reference / tests.
export const LEGACY_FORMULA = "base * (1 + margin)";
