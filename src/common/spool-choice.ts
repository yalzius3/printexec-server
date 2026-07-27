/* Which spool should a job draw from?
   ────────────────────────────────────────────────────────────────────────
   Shared by the piece planner, the bed planner and the auto-scheduler, so the
   answer is the same wherever it's asked. Pure functions, no database.

   Two rules, in order.

   1. OPERATIONAL INVENTORY BEFORE STORAGE. Reaching for a spool that is already
      open before cracking a sealed one is what an operator does anyway: it
      avoids a purge/prime cycle, avoids leaving another part-used spool in the
      rack, and finishes stock instead of accumulating remnants.

      ⚠ This classification MIRRORS isSpoolStorage() in the client's
      windowKit.tsx, which is what renders the Storage / Operational Inventory
      badges and the Assets tab filters. It is computed from grams, NOT from
      asset_stock.status:

          Storage     = untouched — no parent (not a split child), at full
                        initial weight, and nothing reserved.
          Operational = anything else: a gram used, a gram reserved, or a spool
                        split off another.

      Keep the two in sync. If they drift, the packer will prefer a different
      set of spools than the badges say it should, which is invisible until
      someone compares a plan against the Assets screen.

   2. MOST FREE FIRST. Within a tier, prefer the spool with the most unreserved
      grams. "Freedom" in both senses that matter: least likely to run out
      mid-print, and least contended, so the scheduler is not forced to
      serialise every job onto the same nearly-spent spool.

      This deliberately REPLACES a smallest-that-fits rule, which minimised
      leftover but did so by always picking the most nearly exhausted spool —
      maximising both runout risk and spool contention. The cost of the trade is
      that part-used spools are finished less aggressively; rule 1 pulls the
      other way, since a part-used spool is by definition operational.
*/

export type SpoolTier = "operational" | "storage";

/** Defensive numeric coercion — NUMERIC columns arrive from pg as strings. */
function toNum(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The grams-and-lineage shape the classification needs. */
export interface SpoolStockFacts {
  initial_grams?: unknown;
  remaining_grams?: unknown;
  reserved_grams?: unknown;
  /** Non-null when this spool was split off another — never "unopened". */
  parent_asset_id?: unknown;
}

/**
 * Is this spool still sealed stock?
 *
 * Mirrors isSpoolStorage() in the client's windowKit.tsx exactly, including the
 * `remaining >= initial` comparison (rather than ===) and the "unknown grams
 * means operational" fallback. Change both together.
 */
export function isSpoolStorage(s: SpoolStockFacts): boolean {
  // A child spool is operational by definition, whatever its weight says.
  if (s.parent_asset_id != null && s.parent_asset_id !== "") return false;
  const initial = toNum(s.initial_grams);
  const remaining = toNum(s.remaining_grams);
  if (initial == null || remaining == null) return false;
  return remaining >= initial && (toNum(s.reserved_grams) ?? 0) <= 0;
}

export function spoolTier(s: SpoolStockFacts): SpoolTier {
  return isSpoolStorage(s) ? "storage" : "operational";
}

/** Rank order of a tier, lowest first. */
export function spoolTierRank(s: SpoolStockFacts): number {
  return isSpoolStorage(s) ? 1 : 0;
}

export interface RankableSpool extends SpoolStockFacts {
  spool_asset_id: string;
  /** Unreserved grams — remaining minus what other jobs already hold. */
  free: number;
}

/**
 * Preference comparator: best spool first.
 *
 * Operational before storage, then most free grams, then a stable id tiebreak
 * so the same inventory always plans the same way (a plan that reshuffles
 * between two identical dry runs is impossible to review).
 */
export function compareSpoolPreference(a: RankableSpool, b: RankableSpool): number {
  const tier = spoolTierRank(a) - spoolTierRank(b);
  if (tier !== 0) return tier;
  if (b.free !== a.free) return b.free - a.free;
  return a.spool_asset_id.localeCompare(b.spool_asset_id);
}

/** Best spool that can cover `needed` on its own, or null if none can. */
export function bestSingleSpool<T extends RankableSpool>(
  spools: readonly T[], needed: number,
): T | null {
  const fits = spools.filter((s) => s.free >= needed).sort(compareSpoolPreference);
  return fits[0] ?? null;
}

/** Draw order when no single spool covers the job. Same preference, greedily. */
export function combineOrder<T extends RankableSpool>(spools: readonly T[]): T[] {
  return [...spools].sort(compareSpoolPreference);
}
