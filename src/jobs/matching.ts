// ════════════════════════════════════════════════════════════════
// MATCHING KERNEL — the pure "can this stock run this job?" rules.
//
// Sibling of packing.ts (the placement kernel), extracted for the same two
// reasons:
//
//   1. These rules are the ones that keep getting written twice. Compatibility
//      lived as a private techFamily() in simple-jobs.service AND as a raw
//      `!==` in order-pieces.service; the two disagreed, and a resin piece
//      could be assigned by one path then permanently rejected by the other.
//      A rule with one home cannot drift from itself.
//
//   2. They are the rules most worth unit-testing, and they could not be. They
//      previously sat in jobs.service.ts, which declares a Nest service using
//      constructor parameter properties — syntax Node's strip-only TypeScript
//      loader refuses — so `import { techFamily } from "../src/jobs/jobs.service.ts"`
//      in a test dies with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX before a single
//      assertion runs. Pure module, no decorators, directly testable.
//
// jobs.service.ts re-exports everything here, so every existing import site is
// untouched.
//
// Covered by test/resin-matching.test.ts.
// ════════════════════════════════════════════════════════════════

// ────────────────────────────────────────────────────────────
// Material family matching. Filament instances carry marketing names
// ("PLA+", "Silk PLA", "PETG-CF", "TPU-95A", "PA12-CF"…) while printers list
// base families ("PLA", "ABS", "PETG", "TPU", "Nylon"…). A naive exact match
// wrongly rejects common combos (ABS+ on an ABS printer, PLA Matte on a PLA
// printer). We compare by base family instead — fibre/finish/grade suffixes
// don't change which printers can run the material. (Nozzle hardness for
// CF/GF is a separate nozzle-compatibility concern, handled in Stage 3/4.)
// ────────────────────────────────────────────────────────────
export function materialFamily(raw: string): string {
  const u = raw.toUpperCase().replace(/[^A-Z0-9]/g, " ").trim();
  if (u.includes("PETG") || u.includes("PCTG")) return "PETG";
  if (u.includes("PLA")) return "PLA";          // PLA, PLA+, PLA MATTE, SILK PLA, HTPLA, LW-PLA…
  if (u.includes("ABS")) return "ABS";          // ABS, ABS+
  if (u.includes("ASA")) return "ASA";          // ASA, ASA-CF, ASA-GF
  if (u.includes("TPU") || u.includes("FLEX") || u.includes("TPE")) return "TPU";
  if (u.includes("NYLON") || /\bPA\d*/.test(u) || u.startsWith("PA")) return "NYLON";
  if (u.includes("HIPS")) return "HIPS";
  if (u.includes("PVA")) return "PVA";
  if (u.includes("PC")) return "PC";            // PC, PCPBT (PC blend)
  // Fall back to the cleaned token so exotic materials still match by name.
  return u.replace(/\s+/g, "");
}

export function materialsCompatible(filamentMaterial: string, printerMaterial: string): boolean {
  return materialFamily(filamentMaterial) === materialFamily(printerMaterial);
}

/** The two resin technologies. A resin job is stocked, scheduled and finished
 *  differently from an FDM one — it draws millilitres from a tank instead of
 *  grams from a spool, and it isn't done when the printer stops. */
export function isResinTech(tech: string | null | undefined): boolean {
  if (!tech) return false;
  const t = tech.trim().toUpperCase();
  return t === "MSLA" || t === "SLA";
}

/** The FAMILY a technology belongs to, which is the unit compatibility is
 *  actually decided in. MSLA and SLA both cure liquid resin from a tank, so a
 *  part sliced for one prints on the other; only crossing a family (resin ⇄
 *  filament ⇄ powder) is physically impossible.
 *
 *  The two-rule split this replaced: the assign flow used the family rule while
 *  order-pieces.service compared the raw strings with `!==`. They disagreed
 *  exactly where it hurt — the assign flow accepted an SLA piece on an MSLA
 *  printer, then EVERY later edit of that piece went through the strict rule and
 *  died on "assigned_printer_id does not match required_print_technology". A
 *  piece the operator could assign but could never touch again. */
export function techFamily(tech: string): string {
  const t = tech.trim().toUpperCase();
  if (t === "SLA" || t === "MSLA") return "RESIN";
  return t; // FDM, SLS, …
}

/** Can a piece requiring `pieceTech` print on a printer whose technology is
 *  `printerTech`? Either side missing means "unconstrained", not "incompatible". */
export function techCompatible(
  pieceTech: string | null | undefined,
  printerTech: string | null | undefined
): boolean {
  if (!pieceTech || !printerTech) return true;
  return techFamily(pieceTech) === techFamily(printerTech);
}

// Color matching for color slots vs. spools. Simple color names should match
// regardless of case ("Black" == "BLACK" == "black"), but distinct names stay
// distinct ("green" != "blue"). Trim + lowercase is enough for the free-text
// color field; operators who need finer distinction just type different names.
export function sameColor(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

/** Can material of colour `stockColor` fill a demand for colour `wantColor`?
 *
 *  Unlike sameColor (an equality test between two stated colours) this is the
 *  MATCHING rule, and its whole subtlety is the wildcard: an unstated colour on
 *  either side means "unconstrained", not "the empty colour". A job that never
 *  named a colour takes any tank; a tank nobody bothered to label can serve any
 *  job. Only two STATED colours that differ are a real conflict.
 *
 *  Written the strict way — plain equality — every unlabelled tank would drop
 *  out of every pick list, which for resin is the common case (the colour is
 *  optional at intake). Same soft rule the nozzle-material matcher uses. */
export function colorCompatible(
  wantColor: string | null | undefined,
  stockColor: string | null | undefined
): boolean {
  const want = (wantColor ?? "").trim();
  const have = (stockColor ?? "").trim();
  if (!want || !have) return true;
  return want.toLowerCase() === have.toLowerCase();
}

/** A resin tank as the picker needs to judge it. */
export interface TankChoice {
  asset_id: string;
  /** Free millilitres (remaining minus reserved). */
  free_ml: number | null;
  resin_color: string | null;
}

/**
 * Which tank should this job pour from?
 *
 * The rule, in order:
 *   1. Only tanks whose colour can produce the requested colour (colorCompatible
 *      — an unrecorded colour on either side is a wildcard).
 *   2. Among those, the MOST DEPLETED that still covers `needMl`. A shop should
 *      finish an open bottle before breaching a sealed one.
 *   3. Volume unknown yet (the operator fills it in at the slicer step) → the
 *      most depleted compatible tank, same reasoning.
 *   4. Nothing covers it → null. Leave the job unlinked rather than bind a tank
 *      that will fail the volume check later with a confusing error.
 *
 * `tanks` MUST already be ordered emptiest-first; both callers order in SQL.
 *
 * Pure and shared because the two assign paths each needed it and a second
 * hand-written copy is precisely how this subsystem accumulated its bugs — see
 * the techFamily/`!==` split that made a resin piece assignable but uneditable.
 */
export function pickTank(
  tanks: readonly TankChoice[],
  opts: { needMl: number | null; wantColor: string | null | undefined }
): string | null {
  const usable = tanks.filter((t) => colorCompatible(opts.wantColor, t.resin_color));
  if (usable.length === 0) return null;
  if (opts.needMl == null || !(opts.needMl > 0)) {
    return usable[usable.length - 1]?.asset_id ?? null;
  }
  return usable.find((t) => Number(t.free_ml ?? 0) >= opts.needMl!)?.asset_id ?? null;
}
