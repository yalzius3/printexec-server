/* ── Bed outcome settlement ──────────────────────────────────────────────────
   The arithmetic behind triaging a finished plate piece by piece: which parts
   came off good, which failed, which never got printed at all — and what that
   means for the material the plate was holding.

   PURE and dependency-free on purpose, like ./packing.ts and ../jobs/matching.ts.
   Two reasons, and the second is the one that forced the split:

     · this is where money is decided. A wrong share here mis-states stock and
       posts a wrong spoilage figure to the ledger, and neither is visible from
       the screen that caused it. It has to be provable by itself, at every
       shape of input, without a database — see test/bed-outcome.test.ts.
     · `node --test` strips types rather than compiling them, so a module that
       reaches for Nest's parameter properties cannot be imported by a test at
       all. The kernel stays free of the framework so the test can hold the
       REAL function rather than a copy of its rules.

   Nothing here mutates its inputs, reads a clock, or rounds — callers round
   once, at the edge where a number is written or shown.

   ── The rule, stated once ───────────────────────────────────────────────────
   A plate reserves ONE quantity for the whole arrangement (grams of filament,
   or millilitres of resin) — there is no per-piece reservation, because the
   parts print together from one spool or one vat. When the run is triaged, that
   one quantity has to be split three ways, and the split is decided by the
   pieces' OWN quote quantities: the very numbers the plate's total was seeded
   from in the first place (BedsService.assign sums `quoteAssumedMeta` across
   the constituent pieces). Re-using them here is deliberate — deriving a second
   per-piece quantity by some other route would be the same money rule written
   twice, and two expressions eventually disagree.

     done        → its share left the spool and became a good part.
     failed      → the operator's MEASURED waste left the spool, and is booked
                   as spoilage. Not its share: a failure that sprayed 80g of
                   spaghetti wasted 80g, whatever the part was supposed to weigh.
     not started → nothing left the spool. The plate stopped before these parts
                   were laid down, so their share stays on it.

   What leaves stock is therefore `doneShare + measured waste`, and everything
   else simply never gets deducted. The remainder is NOT a separate write —
   it is the part of the reservation the settle does not touch, which is what
   makes it impossible for the two figures to drift apart. */

/**
 * The most pieces one plate may be triaged in a single settle.
 *
 * A plate is physically bounded, so this is not really about plate size — it
 * bounds the TRANSACTION. One settle holds a row lock on the plate and touches
 * every constituent order while it runs, and a transaction that big is one the
 * shop floor waits behind.
 *
 * It lives here, in the module both sides import, because the READ and the
 * WRITE have to agree on it. They did not at first: the console's plan endpoint
 * had no cap at all while the settle capped at 5,000, so a larger plate would
 * load, let an operator triage every row, and only then refuse the commit — the
 * whole job lost at the last step. A limit the list does not know about is a
 * limit that gets discovered in the worst possible way.
 */
export const MAX_PLATE_TRIAGE = 5_000;

/** What the operator decided about one piece on the plate. */
export type PieceOutcome = "done" | "failed" | "not_started";

/** One piece of a plate, as the settlement needs to see it. */
export type PlatePiece = {
  piece_id: string;
  /** The piece's quote quantity in the PLATE's unit — grams on an FDM plate,
   *  millilitres on a resin one (the quote's quantity box holds millilitres for
   *  a resin piece; see BulkPieceEntry). `null` when the piece was never
   *  quoted, which the weighting handles rather than treating as zero. */
  quoteQuantity: number | null;
};

/** A spool the plate reserved against, and how much it was holding. */
export type ReservedSpool = { spoolAssetId: string; plannedGrams: number };

function isPositive(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/**
 * Each piece's weight in the split.
 *
 * A quoted piece weighs its quote. An UNQUOTED piece weighs the average of the
 * quoted ones — treating it as a typical part of this plate, which is the only
 * claim the data supports. Weighting it zero would be a real error: its share
 * would silently return to stock as if the plate had never printed it, and the
 * shop's gram figure would drift a little further from the shelf on every
 * partly-quoted plate. When NOTHING on the plate is quoted every piece weighs
 * 1, which reduces to an equal split.
 *
 * Exported for the test, and because the console shows the same per-piece share
 * to the operator before they commit — the number they see is this one.
 */
export function pieceWeights(pieces: readonly PlatePiece[]): Map<string, number> {
  const quoted = pieces.filter((p) => isPositive(p.quoteQuantity));
  const fallback =
    quoted.length > 0
      ? quoted.reduce((sum, p) => sum + (p.quoteQuantity as number), 0) / quoted.length
      : 1;
  const weights = new Map<string, number>();
  for (const p of pieces) {
    weights.set(p.piece_id, isPositive(p.quoteQuantity) ? p.quoteQuantity : fallback);
  }
  return weights;
}

/**
 * Each piece's share of the plate's planned quantity.
 *
 * Scaled so the shares sum to `plateQuantity` exactly: when the plate's total
 * was seeded from the quotes (the usual case) every share comes back equal to
 * the piece's own quote, and when the operator overrode the total the whole
 * plate is scaled by one ratio rather than some pieces absorbing the difference.
 *
 * `plateQuantity <= 0` (an unmeasured plate) yields all-zero shares rather than
 * a division by zero — the settle then deducts only what the operator measured
 * as waste, which is the correct behaviour for a plate that never had a
 * quantity to spend.
 */
export function pieceShares(
  pieces: readonly PlatePiece[],
  plateQuantity: number,
): Map<string, number> {
  const weights = pieceWeights(pieces);
  const shares = new Map<string, number>();
  if (!isPositive(plateQuantity) || pieces.length === 0) {
    for (const p of pieces) shares.set(p.piece_id, 0);
    return shares;
  }
  let totalWeight = 0;
  for (const w of weights.values()) totalWeight += w;
  if (!(totalWeight > 0)) {
    // Defensive: pieceWeights never returns all-zero (the fallback is 1), but a
    // future caller passing pre-computed weights should degrade to an equal
    // split rather than to NaN — a NaN reaching the UPDATE would set a spool's
    // remaining grams to null and quietly erase a real stock figure.
    const each = plateQuantity / pieces.length;
    for (const p of pieces) shares.set(p.piece_id, each);
    return shares;
  }
  for (const p of pieces) {
    shares.set(p.piece_id, (plateQuantity * (weights.get(p.piece_id) ?? 0)) / totalWeight);
  }
  return shares;
}

export type OutcomeInput = {
  piece_id: string;
  outcome: PieceOutcome;
  /** Operator-measured loss, in the plate's unit. Ignored unless the outcome is
   *  'failed'. Undefined on a failed piece means "assume its whole share",
   *  which mirrors MarkFailedModal pre-filling the planned draw. */
  waste?: number | undefined;
};

export type PieceSettlement = {
  piece_id: string;
  outcome: PieceOutcome;
  /** What the plan expected this piece to consume. */
  share: number;
  /** What it actually cost the spool: its share when done, the measured waste
   *  when failed, nothing when it never started. */
  consumed: number;
  /** The spoilage part of `consumed` — non-zero only on a failed piece. */
  waste: number;
};

export type PlateSettlement = {
  pieces: PieceSettlement[];
  doneCount: number;
  failedCount: number;
  notStartedCount: number;
  /** Σ share of the done pieces — material that became good parts. */
  doneShare: number;
  /** Σ measured waste across the failed pieces — what gets booked as spoilage. */
  wasteTotal: number;
  /** Σ share of the pieces that never started. Reported, never written: it is
   *  the part of the reservation the settle deliberately leaves alone. */
  untouched: number;
  /** What actually leaves stock: `doneShare + wasteTotal`. */
  deduct: number;
};

/**
 * Settle one plate against the operator's per-piece verdict.
 *
 * `clampWasteToShare` mirrors the asymmetry MarkFailedModal already ships, and
 * it is a physical one rather than a stylistic choice:
 *
 *   · FILAMENT waste is NOT clamped. A print that detached and extruded into
 *     open air wastes far more than the part it was supposed to become, and
 *     clamping would quietly under-report a real loss.
 *   · RESIN waste IS clamped to the share. A vat only ever gives up what the
 *     job drew from it; a figure above that is a typo, and honouring it would
 *     invent millilitres that were never in the tank.
 *
 * Pieces the caller did not mention are not this function's business — the
 * service resolves every piece on the plate to an explicit outcome before
 * calling, so a piece can never be silently dropped from the settle.
 */
export function settlePlate(
  pieces: readonly PlatePiece[],
  outcomes: readonly OutcomeInput[],
  plateQuantity: number,
  clampWasteToShare: boolean,
): PlateSettlement {
  const shares = pieceShares(pieces, plateQuantity);
  const byId = new Map(outcomes.map((o) => [o.piece_id, o]));

  const settled: PieceSettlement[] = [];
  let doneCount = 0;
  let failedCount = 0;
  let notStartedCount = 0;
  let doneShare = 0;
  let wasteTotal = 0;
  let untouched = 0;

  for (const p of pieces) {
    const share = shares.get(p.piece_id) ?? 0;
    // Absent = the piece never started. The safe default in both directions:
    // it deducts nothing and books nothing, so a payload that lost a row can
    // under-report a loss but can never invent one.
    const outcome = byId.get(p.piece_id)?.outcome ?? "not_started";

    if (outcome === "done") {
      doneCount += 1;
      doneShare += share;
      settled.push({ piece_id: p.piece_id, outcome, share, consumed: share, waste: 0 });
      continue;
    }
    if (outcome === "failed") {
      failedCount += 1;
      const raw = byId.get(p.piece_id)?.waste;
      // Undefined means "the whole planned draw was lost" — the usual outcome,
      // and the same default markFailed applies to a resin piece.
      const measured = raw === undefined || !Number.isFinite(raw) ? share : Math.max(0, raw);
      const waste = clampWasteToShare ? Math.min(share, measured) : measured;
      wasteTotal += waste;
      settled.push({ piece_id: p.piece_id, outcome, share, consumed: waste, waste });
      continue;
    }
    notStartedCount += 1;
    untouched += share;
    settled.push({ piece_id: p.piece_id, outcome: "not_started", share, consumed: 0, waste: 0 });
  }

  return {
    pieces: settled,
    doneCount,
    failedCount,
    notStartedCount,
    doneShare,
    wasteTotal,
    untouched,
    deduct: doneShare + wasteTotal,
  };
}

/**
 * Split one quantity across the plate's reserved spools, in proportion to what
 * each was holding.
 *
 * A multicolour plate draws from several spools at once and nobody weighs them
 * separately, so proportional-to-planned is the only allocation the data
 * supports. On the ordinary single-spool plate it is exact, and the exactness
 * matters more than it looks: this same function allocates BOTH the stock
 * deduction and each failed piece's spoilage rows, so the two can never
 * disagree about which spool paid for what.
 *
 * Deliberately NOT capped at each spool's planned grams. A measured filament
 * loss is allowed to exceed the plan (see settlePlate), and capping here would
 * silently discard the excess instead of deducting it; the stock UPDATE floors
 * remaining grams at zero, which is where that edge belongs.
 */
export function splitAcrossSpools(
  spools: readonly ReservedSpool[],
  quantity: number,
): { spoolAssetId: string; grams: number }[] {
  if (spools.length === 0 || !(quantity > 0)) return [];
  let planned = 0;
  for (const s of spools) planned += s.plannedGrams > 0 ? s.plannedGrams : 0;
  if (!(planned > 0)) {
    // Every reservation row is zero/blank — fall back to an equal split so the
    // loss still lands somewhere rather than vanishing.
    const each = quantity / spools.length;
    return spools.map((s) => ({ spoolAssetId: s.spoolAssetId, grams: each }));
  }
  return spools
    .filter((s) => s.plannedGrams > 0)
    .map((s) => ({
      spoolAssetId: s.spoolAssetId,
      grams: (quantity * s.plannedGrams) / planned,
    }));
}

/**
 * The status a re-queued piece returns to, and whether that is even reachable.
 *
 * A piece coming off a dismantled plate has had its own printer/nozzle/slicer
 * columns null the whole time it was bedded — the bed owned its lifecycle. The
 * `bed_id IS NOT NULL` escape in chk_assigned_requires_printer and
 * chk_ready_requires_core_data is what allowed that, and detaching the piece
 * REVOKES that escape on the very same statement that clears bed_id. So a piece
 * sent back to 'assigned' has to carry a printer out of the plate with it, or
 * the write is a CHECK violation surfacing as a bare 500.
 *
 * Returns 'pending' whenever there is no printer to inherit, which is a real
 * case: a plate can be triaged after its printer was deleted or taken offline.
 */
export function requeueStatus(
  requested: "assigned" | "pending",
  bedPrinterId: string | null,
): "assigned" | "pending" {
  return requested === "assigned" && bedPrinterId ? "assigned" : "pending";
}
