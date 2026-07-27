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
 * First-fit: the job settles into the first gap wide enough to hold it, so a
 * short job backfills a hole between two prints instead of queueing behind all
 * of them. That backfilling is where most of the machine utilisation comes from.
 *
 * `gapMs` of 0 lets blocks touch edge-to-edge but never overlap.
 *
 * ── Complexity ───────────────────────────────────────────────────────────
 * O(n log n), sort-dominated; O(n) over the intervals themselves.
 *
 * A note, because the previous version looked worse than it was and someone
 * will eventually "re-optimise" this: the old fixed-point loop (rescan all
 * intervals until a pass moves nothing) was NOT quadratic. It always settled
 * in one working pass plus one confirming pass, verified by fuzzing 200k
 * random boards — the observed maximum was 2.
 *
 * The reason is the same invariant this version relies on. Scanning in sorted
 * order, if interval j does not overlap when visited then s_j >= start + dur;
 * every later interval has s >= s_j, so none of them overlap either, so
 * `start` can never grow again after j. One pass therefore fixes everything.
 *
 * So this rewrite buys clarity and roughly half the comparisons (one pass, and
 * an early break as soon as an interval starts beyond the job's end) — not a
 * complexity class. Don't expect it to change behaviour on a large board.
 */
export function earliestFit(
  busy: readonly Interval[],
  durMs: number,
  notBefore: number,
  gapMs: number,
): number {
  if (busy.length === 0) return notBefore;
  const padded = busy
    .map((iv) => ({ s: iv.s - gapMs, e: iv.e + gapMs }))
    .sort((a, b) => a.s - b.s);
  let start = notBefore;
  for (const iv of padded) {
    if (iv.e <= start) continue;          // already behind the candidate
    if (iv.s >= start + durMs) break;     // this and all later ones clear it
    start = iv.e;                         // overlap — settle just past it
  }
  return start;
}

/* ── Working hours ─────────────────────────────────────────────────────────
   A shop that isn't staffed round the clock needs prints to START while
   somebody is there to load the plate and press go. A long print may then run
   unattended past closing — that's normal and explicitly allowed. So the
   window constrains the START instant only, never the finish.

   Hours are the SHOP's local hours. The server may well run in UTC in another
   country, so the caller supplies its own UTC offset rather than the process
   trusting its own timezone.

   A window whose latest start is before its earliest start wraps midnight
   (a night shift, 22:00 → 06:00). */
export interface WorkWindow {
  /** Earliest local hour a print may start, 0–23. */
  startHour: number;
  /** Latest local hour a print may start, 0–23. Exclusive. */
  latestStartHour: number;
  /** Minutes to ADD to UTC to reach the shop's local time (Cairo = +120). */
  tzOffsetMinutes: number;
}

const HOUR_MS = 3_600_000;
const DAY_MS_LOCAL = 86_400_000;

/** Local hour-of-day (fractional) for an instant, in the shop's timezone. */
function localHourOf(ms: number, w: WorkWindow): number {
  const shifted = ms + w.tzOffsetMinutes * 60_000;
  const intoDay = ((shifted % DAY_MS_LOCAL) + DAY_MS_LOCAL) % DAY_MS_LOCAL;
  return intoDay / HOUR_MS;
}

/** Instant of the given local hour on the same local day as `ms`. */
function localHourInstant(ms: number, hour: number, w: WorkWindow): number {
  const shifted = ms + w.tzOffsetMinutes * 60_000;
  const dayStart = Math.floor(shifted / DAY_MS_LOCAL) * DAY_MS_LOCAL;
  return dayStart + hour * HOUR_MS - w.tzOffsetMinutes * 60_000;
}

/** True when a print may be STARTED at this instant. */
export function isWithinWorkWindow(ms: number, w: WorkWindow | null | undefined): boolean {
  if (!w) return true;
  const h = localHourOf(ms, w);
  // A full-day window (or a nonsensical equal pair) never blocks anything.
  if (w.startHour === w.latestStartHour) return true;
  return w.startHour < w.latestStartHour
    ? h >= w.startHour && h < w.latestStartHour
    : h >= w.startHour || h < w.latestStartHour;   // wraps midnight
}

/**
 * The first instant at or after `ms` when a print may be started.
 * Returns `ms` unchanged when it's already inside the window.
 */
export function nextAllowedStart(ms: number, w: WorkWindow | null | undefined): number {
  if (!w || isWithinWorkWindow(ms, w)) return ms;
  const opensToday = localHourInstant(ms, w.startHour, w);
  // Before this morning's opening → wait for it. Otherwise the day is done and
  // the next opening is tomorrow's.
  return opensToday > ms ? opensToday : opensToday + DAY_MS_LOCAL;
}

/**
 * Earliest start that clears every busy interval AND falls inside the shop's
 * working hours.
 *
 * The two constraints interact: opening the doors can land you on top of a
 * booked block, and dodging a booked block can push you past closing. Both
 * only ever move the candidate FORWARD, so alternating them converges — and
 * because each pass either returns or strictly advances, it terminates.
 *
 * The iteration cap is a safety net, not a limit reached in practice: a job is
 * only re-examined once per conflict and once per day of the horizon, and the
 * caller rejects anything beyond 60 days anyway.
 */
export function earliestFitWithin(
  busy: readonly Interval[],
  durMs: number,
  notBefore: number,
  gapMs: number,
  window: WorkWindow | null | undefined,
): number {
  if (!window) return earliestFit(busy, durMs, notBefore, gapMs);
  let start = notBefore;
  for (let guard = 0; guard < 512; guard++) {
    const opened = nextAllowedStart(start, window);
    const fitted = earliestFit(busy, durMs, opened, gapMs);
    if (fitted === opened) return fitted;   // inside the window and conflict-free
    start = fitted;
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
 * How much freedom the packer has over which nozzle a job uses.
 *
 *  · `earliest`         — substitute any equivalent nozzle that opens an
 *                         earlier slot. Best throughput, most handling.
 *  · `keep_assigned`    — never substitute; each job uses the nozzle a human
 *                         picked. The packer only decides WHEN.
 *  · `minimise_changes` — one nozzle per printer per required spec, reused for
 *                         every job on that printer needing that spec. A change
 *                         then only happens where the SPEC changes, which is
 *                         physics rather than a scheduling choice. Shops that
 *                         would rather queue than keep swapping hardware want
 *                         this, and it can cost throughput — that's the trade
 *                         being made deliberately.
 */
export type NozzlePolicy = "earliest" | "keep_assigned" | "minimise_changes";

/**
 * The nozzle SPEC a job needs, independent of which physical nozzle serves it.
 *
 * This is the unit that matters at the machine. Two different 0.4mm brass
 * nozzles are interchangeable — if one is already fitted, the operator runs the
 * next job on it and never touches a spanner. What costs a real replacement is
 * the spec changing: 0.4 → 0.5, or brass → hardened.
 *
 * Null spec ("any nozzle will do") is its own bucket rather than a wildcard
 * that silently merges with every other spec.
 */
export function nozzleSpecOf(dia: number | null, mat: string | null): string {
  return `${dia ?? "any"}|${(mat ?? "any").toLowerCase()}`;
}

/** Key identifying "jobs that can share one nozzle on one printer". */
export function nozzleSpecKey(
  printerId: string, dia: number | null, mat: string | null,
): string {
  return `${printerId}|${nozzleSpecOf(dia, mat)}`;
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
  policy?: NozzlePolicy;
  /** `minimise_changes` only: the nozzle already committed to this printer for
   *  this spec earlier in the plan. Reused verbatim so the printer never
   *  rotates hardware mid-run. */
  pinnedId?: string | null | undefined;
}): NozzleDecision {
  const { assignedId, printerId, options, earliestFor } = args;
  const policy: NozzlePolicy = args.policy ?? "earliest";
  const baselineStart = earliestFor(assignedId);
  // No assigned nozzle means there's nothing to substitute FOR — assigning one
  // where a human left it blank is a different decision than this makes.
  if (!assignedId || options.length === 0 || policy === "keep_assigned") {
    return { id: assignedId, startMs: baselineStart, movedFromPrinterId: null, label: null, swapped: false };
  }

  const rankOf = (n: NozzleOption): number => {
    if (n.nozzle_asset_id === assignedId) return 0;
    if (!n.installed_on || n.installed_on === printerId) return 1;
    return 2;
  };
  const decisionFor = (n: NozzleOption): NozzleDecision => ({
    id: n.nozzle_asset_id,
    startMs: earliestFor(n.nozzle_asset_id),
    movedFromPrinterId: n.installed_on && n.installed_on !== printerId ? n.installed_on : null,
    label: n.label,
    swapped: n.nozzle_asset_id !== assignedId,
  });

  // ── minimise_changes: the printer keeps ONE nozzle per spec for the whole
  //    plan. Timing is an outcome, not an input — deliberately, since the whole
  //    point is to stop optimising throughput at the cost of hardware handling.
  if (policy === "minimise_changes") {
    const pinned = args.pinnedId
      ? options.find((n) => n.nozzle_asset_id === args.pinnedId)
      : undefined;
    if (pinned) return decisionFor(pinned);
    // Nothing pinned for this spec yet — take the least disruptive nozzle that
    // fits and let the caller pin it for everything that follows.
    const best = [...options].sort((a, b) => rankOf(a) - rankOf(b))[0];
    return best ? decisionFor(best)
      : { id: assignedId, startMs: baselineStart, movedFromPrinterId: null, label: null, swapped: false };
  }

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
