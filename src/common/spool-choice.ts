/* Which spool should a job draw from?
   ────────────────────────────────────────────────────────────────────────
   Shared by the piece planner, the bed planner and the auto-scheduler, so the
   answer is the same wherever it's asked. Pure functions, no database.

   Two rules, in order.

   1. OPERATIONAL BEFORE STORAGE. A spool that is already mounted or already
      open is operational; a sealed one on a shelf is storage. Reaching for the
      loaded spool before cracking a new one is what an operator does anyway:
      it avoids a purge/prime cycle, avoids leaving another part-used spool in
      the rack, and needs no walk to the shelf.

      Note the mapping, because the schema has no literal "operational" flag:
      asset_stock.status of 'installed' or 'in_use' IS operational; 'available'
      is storage. ('empty' and 'damaged' never reach here — the planner filters
      them out.) If a first-class inventory-location field ever lands, this is
      the one place that has to change.

   2. MOST FREE FIRST. Within a tier, prefer the spool with the most unreserved
      grams. "Freedom" in both senses that matter: it is least likely to run out
      mid-print, and it is the least contended, so the scheduler is not forced
      to serialise every job onto the same nearly-spent spool.

      This deliberately REPLACES a smallest-that-fits rule, which minimised
      leftover but did so by always picking the most nearly exhausted spool —
      maximising both runout risk and spool contention. The cost of the trade is
      that part-used spools are finished less aggressively; rule 1 pulls the
      other way, since a part-used spool is usually the one that is open.
*/

export type SpoolTier = "operational" | "storage";

/** Statuses that mean the spool is already out and threaded. */
const OPERATIONAL_STATUSES = new Set(["installed", "in_use"]);

export function spoolTier(status: string | null | undefined): SpoolTier {
  return OPERATIONAL_STATUSES.has((status ?? "").toLowerCase()) ? "operational" : "storage";
}

/** Rank order of a tier, lowest first. */
export function spoolTierRank(status: string | null | undefined): number {
  return spoolTier(status) === "operational" ? 0 : 1;
}

export interface RankableSpool {
  spool_asset_id: string;
  status: string;
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
  const tier = spoolTierRank(a.status) - spoolTierRank(b.status);
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
