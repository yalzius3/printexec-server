/* The scheduling kernel — pure functions, no database, no clock.
   ────────────────────────────────────────────────────────────────────────
   Extracted out of autoSchedule() so the parts that are genuinely hard to get
   right (gap-fitting, margin padding, nozzle substitution, least-slack order)
   can be tested directly instead of only through a live board. autoSchedule
   keeps the I/O — loading blocks, reserving spools, committing — and calls in
   here for every decision.

   Everything is milliseconds and pure: same inputs, same answer, no Date.now().
*/

export interface Interval {
  /** Inclusive start, epoch ms. */
  s: number;
  /** Exclusive end, epoch ms. */
  e: number;
}

/**
 * Earliest instant ≥ `notBefore` where a `durMs` job clears every busy interval,
 * each padded by `gapMs` on both sides.
 *
 * First-fit forward scan: start at the floor and jump to the end of whatever
 * overlaps, repeating until a full pass moves nothing. Because it only ever
 * jumps to the END of a conflict, it settles into the first gap wide enough to
 * hold the job — so a short job backfills a hole between two prints instead of
 * queueing behind all of them. That backfilling is where most of the machine
 * utilisation comes from.
 *
 * `gapMs` of 0 lets blocks touch edge-to-edge but never overlap.
 *
 * Terminates because every move is strictly forward to some interval's end, and
 * there are finitely many intervals.
 */
export function earliestFit(
  busy: readonly Interval[],
  durMs: number,
  notBefore: number,
  gapMs: number,
): number {
  if (busy.length === 0) return notBefore;
  // Sorting is not required for correctness (the loop runs to a fixed point)
  // but it makes the common case settle in one pass.
  const sorted = [...busy].sort((a, b) => a.s - b.s);
  let start = notBefore;
  let moved = true;
  while (moved) {
    moved = false;
    for (const iv of sorted) {
      if (start < iv.e + gapMs && start + durMs > iv.s - gapMs) {
        start = iv.e + gapMs;
        moved = true;
      }
    }
  }
  return start;
}

export interface NozzleOption {
  nozzle_asset_id: string;
  nozzle_diameter_mm: number | null;
  nozzle_material: string | null;
  status: string;
  /** Printer this nozzle is currently mounted on, if any. */
  installed_on: string | null;
  label: string;
}

/**
 * Does this nozzle satisfy a piece's requirement?
 *
 * Mirrors resolveNozzleFor in the assign flow: diameter must match when the
 * piece states one; material must match when BOTH state one, so a nozzle with
 * no recorded material is a wildcard. Keep the two in sync — if they disagree,
 * the packer will plan swaps that setNozzle() then rejects.
 */
export function nozzleFits(
  n: Pick<NozzleOption, "nozzle_diameter_mm" | "nozzle_material">,
  dia: number | null,
  mat: string | null,
): boolean {
  if (dia != null && Number(n.nozzle_diameter_mm) !== Number(dia)) return false;
  if (mat && n.nozzle_material && n.nozzle_material.toLowerCase() !== mat.toLowerCase()) return false;
  return true;
}

/** The only stock status that makes a nozzle unusable. 'installed' and 'in_use'
 *  are normal — a mounted nozzle is usually exactly the one we want. */
export const UNUSABLE_NOZZLE_STATUS = "damaged";

export interface NozzleDecision {
  id: string | null;
  startMs: number;
  /** Set when the chosen nozzle currently sits on a DIFFERENT printer, i.e.
   *  someone has to physically carry it over before this start. */
  movedFromPrinterId: string | null;
  label: string | null;
  swapped: boolean;
}

/**
 * Pick the nozzle that opens the earliest slot.
 *
 * A nozzle is interchangeable with any other of the same diameter + material,
 * so "which nozzle" is a choice, not a fixed input. One busy 0.4mm brass nozzle
 * would otherwise stall every piece wanting a 0.4mm brass nozzle, which is the
 * single biggest source of false serialisation on a multi-printer floor.
 *
 * Ties break by how disruptive the choice is, cheapest first:
 *   0. the nozzle already assigned          — nothing to explain
 *   1. one already on this printer, or idle — no walking
 *   2. one mounted on another printer       — a real physical move
 *   3. the assigned nozzle when it does NOT meet the spec — so any conforming
 *      nozzle displaces it even at equal time
 *
 * A swap therefore only happens when it buys strictly earlier time, or when it
 * corrects a nozzle that never matched the requirement.
 *
 * @param earliestFor Earliest start achievable with a given nozzle booked
 *                    (null = ignore nozzle contention entirely).
 */
export function chooseNozzle(args: {
  assignedId: string | null;
  printerId: string;
  options: readonly NozzleOption[];
  earliestFor: (nozzleId: string | null) => number;
}): NozzleDecision {
  const { assignedId, printerId, options, earliestFor } = args;
  const baselineStart = earliestFor(assignedId);
  // No assigned nozzle means there's nothing to substitute FOR — assigning one
  // where a human left it blank is a different decision than this makes.
  if (!assignedId || options.length === 0) {
    return { id: assignedId, startMs: baselineStart, movedFromPrinterId: null, label: null, swapped: false };
  }

  const rankOf = (n: NozzleOption): number => {
    if (n.nozzle_asset_id === assignedId) return 0;
    if (!n.installed_on || n.installed_on === printerId) return 1;
    return 2;
  };

  let best = {
    id: assignedId as string | null,
    start: baselineStart,
    rank: options.some((n) => n.nozzle_asset_id === assignedId) ? 0 : 3,
    moveFrom: null as string | null,
    label: null as string | null,
  };
  for (const n of options) {
    if (n.nozzle_asset_id === assignedId) continue;
    const s = earliestFor(n.nozzle_asset_id);
    const rank = rankOf(n);
    if (s < best.start || (s === best.start && rank < best.rank)) {
      best = {
        id: n.nozzle_asset_id,
        start: s,
        rank,
        moveFrom: n.installed_on && n.installed_on !== printerId ? n.installed_on : null,
        label: n.label,
      };
    }
  }
  return {
    id: best.id,
    startMs: best.start,
    movedFromPrinterId: best.moveFrom,
    label: best.label,
    swapped: best.id !== assignedId,
  };
}

/**
 * Slack (minimum laxity): idle buffer a job has before its deadline if it
 * started as early as possible.
 *
 *     slack = deadline − now − duration
 *
 * Negative means it cannot make the deadline even starting now. No deadline
 * means +∞, so undated work packs last, after everything time-critical.
 *
 * The client mirrors this exactly (client src/jobs/risk.ts) so a colour on a
 * row means the same thing as a number in the plan. Keep the two in sync.
 */
export function slackMs(
  deadlineIso: string | null,
  nowMs: number,
  durationMinutes: number | null,
): number {
  if (!deadlineIso) return Infinity;
  const dl = Date.parse(deadlineIso);
  if (Number.isNaN(dl)) return Infinity;
  return dl - nowMs - Math.max(0, durationMinutes ?? 0) * 60_000;
}

export interface SlackSortable {
  id: string;
  deadline: string | null;
  minutes: number | null;
}

/**
 * Least-slack-first comparator.
 *
 * Beats plain earliest-deadline because it accounts for how LONG each job runs:
 * a 3h job due in 4h is tighter than a 10min job due in 1h, and only slack sees
 * that. Ties break by earlier deadline, then the caller's original order.
 */
export function compareBySlack<T extends SlackSortable>(
  a: T, b: T, nowMs: number, orderIndex: ReadonlyMap<string, number>,
): number {
  const sa = slackMs(a.deadline, nowMs, a.minutes);
  const sb = slackMs(b.deadline, nowMs, b.minutes);
  if (sa !== sb) return sa - sb;
  const da = a.deadline ? Date.parse(a.deadline) : Infinity;
  const db = b.deadline ? Date.parse(b.deadline) : Infinity;
  if (da !== db) return da - db;
  return (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0);
}
