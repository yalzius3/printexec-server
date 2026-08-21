import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import { JobsService, colorCompatible, isResinTech, pickTank, techFamily, type NozzleSwitch } from "../jobs/jobs.service";
import { BedsService } from "../beds/beds.service";
import { FinanceService } from "../finance/finance.service";
import { RunsService } from "../runs/runs.service";
import {
  propagateSlicerMetaToDuplicatesTx,
  quoteAssumedMeta,
  recomputeOrderStatusTx,
  releasePrinterForPieceTx,
} from "../common/cascade";
// The scheduling kernel — pure, unit-tested placement math (see packing.ts and
// test/packing.test.ts). autoSchedule keeps the I/O and calls in here to decide.
import {
  earliestFitAcross,
  pushInterval,
  chooseNozzle,
  nozzleFits,
  nozzleSpecKey,
  nozzleSpecOf,
  orderForFewestSetups,
  compareBySlack,
  nextAllowedStart,
  openMsBetween,
  UNUSABLE_NOZZLE_STATUS,
  type Interval,
  type NozzleOption,
  type NozzlePolicy,
  type WorkWindow,
} from "./packing";

/**
 * Fleet packs of at least this many items go through a background run instead
 * of the request that asked for one.
 *
 * Not really a performance threshold — an honesty one. Below it a pack is a
 * second or two, and a single round trip is the better experience. Above it the
 * operator is waiting on something they cannot see, cannot stop, and which the
 * edge proxy may cut off part-way — and a commit cut off part-way is the worst
 * of those three, because the placements it managed to make are real.
 */
const RUN_THRESHOLD_ITEMS = 300;

// The piece as the two re-queue paths (markFailed, sendBackToProduction) need to
// see it: enough to validate the move, reconcile its material, and free what it
// was holding. Both load it through loadRequeueablePiece.
type RequeueablePiece = {
  piece_id: string;
  order_id: string;
  order_number: string;
  piece_name: string;
  status: string;
  assigned_printer_id: string | null;
  bed_id: string | null;
  required_print_technology: string | null;
  resin_tank_id: string | null;
  slicer_resin_used_ml: string | null;
};

@Injectable()
export class SimpleJobsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly jobsService: JobsService,
    private readonly bedsService: BedsService,
    private readonly finance: FinanceService,
    // Progress + cancellation for packs too large to be one request. The pack
    // itself never learns what a run is — see autoScheduleAll.
    private readonly runs: RunsService
  ) {}

  // Every piece the company has, full stop.
  //
  // This used to be scoped to orders whose operation_mode matched the company's
  // — the two-workspace world, where Simple and Advanced each showed only their
  // own work and the mode was reversible. Advanced is retired end to end: the
  // client has no mode toggle and no Advanced workspace to switch back to. What
  // survived was a filter that can only ever HIDE work, and it hides it with no
  // error at all — a company still stamped 'advanced' from the pre-2026-07-21
  // column default (that migration changed the DEFAULT, not existing rows) shows
  // an empty queue while every order sits there in the database. Any order
  // predating a mode flip does the same thing individually, because the insert
  // trigger stamps the mode that was current when the order was written.
  //
  // There is no longer a second mode for a piece to belong to, so there is
  // nothing left to filter on.
  async listQueue(companyId: string) {
    const result = await this.db.query(
      `
        SELECT
          op.piece_id,
          op.order_id,
          o.order_number AS order_reference,
          o.deadline AS order_deadline,
          op.piece_name,
          op.status,
          op.assigned_printer_id,
          CASE
            WHEN pi.printer_id IS NOT NULL
              THEN NULLIF(TRIM(CONCAT_WS(' ', pi.brand, pi.model)), '')
            ELSE NULL
          END AS assigned_printer_label,
          op.required_print_technology,
          op.required_filament_material,
          op.required_color,
          op.cost,
          op.slicer_filament_used_grams::double precision AS slicer_filament_used_grams,
          CASE
            WHEN c.customer_type = 'b2b' THEN c.business_name
            ELSE concat_ws(' ', c.first_name, c.last_name)
          END AS customer_name
        FROM order_pieces op
        INNER JOIN orders o
          ON o.order_id = op.order_id
        LEFT JOIN customers c
          ON c.customer_id = o.customer_id
        LEFT JOIN printer_instances pi
          ON pi.printer_id = op.assigned_printer_id
        WHERE op.company_id = $1
        ORDER BY LOWER(op.piece_name) ASC, op.created_at ASC
      `,
      [companyId]
    );
    return result.rows;
  }

  // Soft bulk-assign to a printer: no time, no scheduling. The only hard block
  // is a print-technology FAMILY mismatch (FDM ⇄ resin ⇄ SLS) — the
  // physically-impossible case. Everything else (multicolor, material) is the
  // operator's call. Incompatible pieces are skipped and reported, not thrown,
  // so the rest still assign.
  //
  // Nozzle: each piece is stamped with the nozzle matching ITS OWN
  // required diameter + material — not a single nozzle shared across the whole
  // batch. So a bulk assign of (hardened-steel 0.4 / brass 0.5 / stainless 0.6)
  // lands each piece on its correct nozzle, which is what makes the per-nozzle
  // timeline read correctly afterwards. `nozzleIds` carries the operator's
  // explicit picks (one per requirement from the bulk picker); `nozzleId` is the
  // legacy single-pick. Either is matched per piece; anything unmatched falls
  // back to an auto-resolved compatible nozzle, then the printer default.
  async assign(
    companyId: string,
    pieceIds: string[],
    printerId: string,
    nozzleId?: string,
    nozzleIds?: string[],
    /** Resin's counterpart of `nozzleId`: the operator overrode which tank this
     *  batch pours from. Omitted = auto-resolve (see resolveTankFor). */
    resinTankId?: string,
    /** Packed PLATES assigned in the same call. Handled after the pieces, down
     *  the same printer/nozzle/tank resolution, so a mixed selection is one
     *  operator action and one set of compatibility rules. */
    bedIds: string[] = []
  ) {
    const printerResult = await this.db.query<{ print_technology: string | null }>(
      `
        SELECT COALESCE(pr.print_technology, pi.print_technology) AS print_technology
        FROM printer_instances pi
        LEFT JOIN printer_reference pr
          ON pr.printer_ref_id = pi.printer_ref_id
        WHERE pi.company_id = $1
          AND pi.printer_id = $2
      `,
      [companyId, printerId]
    );
    const printer = printerResult.rows[0];
    if (!printer) {
      throw new BadRequestException("Printer does not exist for this company.");
    }
    const printerFamily = printer.print_technology ? techFamily(printer.print_technology) : null;

    // Every nozzle compatible with this printer, with spec + stock state.
    // Pre-sorted available-first then smallest-diameter so the first match is
    // the sensible default / auto-pick. Used to (a) validate explicit picks and
    // (b) resolve a per-piece nozzle below. May be empty for printers with no
    // nozzle concept (e.g. resin) — then pieces keep whatever nozzle they have.
    const printerNozzles = await this.db.query<{
      nozzle_asset_id: string;
      nozzle_diameter_mm: number | null;
      nozzle_material: string | null;
      nozzle_status: string;
    }>(
      `
        SELECT pnc.nozzle_asset_id,
               ai.nozzle_diameter_mm,
               ai.nozzle_material,
               COALESCE(asto.status, 'available') AS nozzle_status
        FROM printer_nozzle_compatibility pnc
        JOIN asset_instances ai ON ai.asset_id = pnc.nozzle_asset_id
        LEFT JOIN asset_stock asto ON asto.asset_id = pnc.nozzle_asset_id
        WHERE pnc.company_id = $1 AND pnc.printer_id = $2
        ORDER BY (COALESCE(asto.status, 'available') = 'available') DESC,
                 ai.nozzle_diameter_mm ASC NULLS LAST
      `,
      [companyId, printerId]
    );
    const compatById = new Map(printerNozzles.rows.map((n) => [n.nozzle_asset_id, n]));
    const defaultNozzleId = printerNozzles.rows[0]?.nozzle_asset_id ?? null;

    // ── Resin tanks: the resin analogue of the nozzle rack above ─────────────
    // A resin piece needs a tank the way an FDM piece needs a nozzle — it cannot
    // reach 'ready' (or pass chk_ready_requires_core_data) without one. Assigning
    // resolves it here, so one click does the same work for resin that it already
    // did for filament instead of parking the piece until someone links a tank by
    // hand in the detail window.
    //
    // Ordered MOST DEPLETED FIRST among tanks that can still cover the job: a
    // shop should finish the bottle that is already open before breaching a
    // sealed one. Expired, damaged and split-parent tanks are excluded outright,
    // and a tank formulated for the other light source can't print this job.
    const isResinPrinter = printerFamily === "RESIN";
    const printerTech = (printer.print_technology ?? "").trim().toUpperCase();
    const resinTanks = isResinPrinter
      ? (
          await this.db.query<{ asset_id: string; free_ml: string | null; resin_color: string | null }>(
            `
              SELECT ai.asset_id,
                     ai.resin_color,
                     COALESCE(ast.remaining_volume_ml, 0) - COALESCE(ast.reserved_volume_ml, 0) AS free_ml
                FROM asset_instances ai
                JOIN asset_stock ast ON ast.asset_id = ai.asset_id
               WHERE ai.company_id = $1
                 AND ai.asset_type = 'resin_tank'
                 AND ai.split_at IS NULL
                 AND COALESCE(ast.status, 'available') NOT IN ('damaged', 'empty')
                 AND (ai.resin_expiry_date IS NULL OR ai.resin_expiry_date >= CURRENT_DATE)
                 AND (COALESCE(ai.resin_tech_compat, 'both') = 'both'
                      OR COALESCE(ai.resin_tech_compat, 'both') = $2)
               ORDER BY free_ml ASC
            `,
            [companyId, printerTech]
          )
        ).rows
      : [];
    // An explicit tank must be a real, usable tank for THIS printer — validated
    // against the same roster the auto-resolver draws from, so an override can
    // never smuggle in an expired or wrong-light-source bottle that the
    // automatic path would have refused.
    if (resinTankId) {
      if (!isResinPrinter) {
        throw new BadRequestException("Resin tanks only apply to MSLA/SLA printers.");
      }
      if (!resinTanks.some((t) => t.asset_id === resinTankId)) {
        throw new BadRequestException(
          "That resin tank is unavailable for this printer — it may be empty, expired, split, or formulated for the other resin technology."
        );
      }
    }
    /** The emptiest tank of the RIGHT COLOUR that still covers `needMl` (any
     *  volume when it isn't known yet — the operator fills it in at the slicer
     *  step). An explicit pick always wins: the operator can see the vat.
     *
     *  Colour is a hard filter here because a resin part comes out the colour of
     *  the liquid it was cured from — there is no way to correct it afterwards,
     *  so pouring a blue print from the yellow vat scraps the part. An
     *  unrecorded colour on either side stays a wildcard (see colorCompatible),
     *  so shops that don't track colour are unaffected. */
    const resolveTankFor = (needMl: number | null, wantColor: string | null): string | null =>
      resinTankId ?? pickTank(
        resinTanks.map((t) => ({
          asset_id: t.asset_id,
          free_ml: t.free_ml == null ? null : Number(t.free_ml),
          resin_color: t.resin_color,
        })),
        { needMl, wantColor }
      );

    // The operator's explicit picks (bulk: one per requirement). De-duped.
    // Every pick must be compatible with the chosen printer.
    const chosenIds = Array.from(new Set([...(nozzleIds ?? []), ...(nozzleId ? [nozzleId] : [])]));
    for (const id of chosenIds) {
      if (!compatById.has(id)) {
        throw new BadRequestException("Selected nozzle is not compatible with the selected printer.");
      }
    }

    // A nozzle satisfies a requirement when its diameter matches (when the piece
    // states one) and its material matches (when both state one — a material-less
    // nozzle is treated as a wildcard, mirroring the Advanced filter).
    const nozzleMatches = (
      n: { nozzle_diameter_mm: number | null; nozzle_material: string | null },
      diaReq: number | null,
      matReq: string | null
    ): boolean => {
      if (diaReq != null && Number(n.nozzle_diameter_mm) !== Number(diaReq)) return false;
      if (matReq && n.nozzle_material && n.nozzle_material.toLowerCase() !== matReq.toLowerCase()) return false;
      return true;
    };
    // Best nozzle for one piece: an explicit pick that fits → any compatible
    // nozzle that fits (available-first via the query order) → printer default.
    const resolveNozzleFor = (dia: number | null, mat: string | null): string | null => {
      const picked = chosenIds.find((id) => {
        const n = compatById.get(id);
        return n ? nozzleMatches(n, dia, mat) : false;
      });
      if (picked) return picked;
      const auto = printerNozzles.rows.find((n) => nozzleMatches(n, dia, mat));
      return auto?.nozzle_asset_id ?? defaultNozzleId;
    };

    const pieceResult = await this.db.query<{
      piece_id: string;
      piece_name: string;
      required_print_technology: string | null;
      required_nozzle_diameter_mm: number | null;
      required_nozzle_material: string | null;
      required_color: string | null;
      status: string;
      requires_multicolor: boolean | null;
      cost_inputs: { grams?: string[]; time?: string; failure?: string } | null;
    }>(
      `
        SELECT piece_id, piece_name, required_print_technology,
               required_nozzle_diameter_mm, required_nozzle_material,
               -- Resin's material constraint. A resin part cures the colour of
               -- the vat, so this is what decides which tank can print it.
               required_color, status,
               requires_multicolor, cost_inputs
        FROM order_pieces
        WHERE company_id = $1
          AND piece_id = ANY($2::uuid[])
      `,
      [companyId, pieceIds]
    );

    const skipped: { piece_id: string; piece_name: string; reason: string }[] = [];
    // Pieces that WERE assigned but stopped short of 'ready', with the reason.
    // Distinct from `skipped` (not assigned at all) — the operator needs to tell
    // "I did nothing with this" apart from "I did half of it, here's the rest".
    const notes: { piece_id: string; piece_name: string; note: string }[] = [];
    // Group assignable pieces by (nozzle, assumed time, assumed grams) so each
    // distinct combination is a single UPDATE (nozzle null = none resolved →
    // keep existing).
    // `grams` and `ml` are mutually exclusive: a piece is filament or resin, and
    // the quote's single quantity lands in whichever column its technology uses.
    type SeedGroup = {
      nozzle: string | null;
      tank: string | null;
      minutes: number | null;
      grams: number | null;
      ml: number | null;
      // Which technology this group is, carried explicitly so the UPDATE can
      // CLEAR the other technology's tooling rather than merely not set it.
      isResin: boolean;
      ids: string[];
    };
    const groups = new Map<string, SeedGroup>();
    // Multicolor pieces whose quote grams can seed the per-slot demand.
    const slotSeeds: { piece_id: string; grams: number[] }[] = [];
    let assignedCount = 0;
    for (const piece of pieceResult.rows) {
      if (piece.status === "printing" || piece.status === "done") {
        skipped.push({ piece_id: piece.piece_id, piece_name: piece.piece_name, reason: "already in production" });
        continue;
      }
      if (piece.status === "scheduled") {
        skipped.push({ piece_id: piece.piece_id, piece_name: piece.piece_name, reason: "scheduled — unschedule it first" });
        continue;
      }
      if (
        piece.required_print_technology &&
        printerFamily &&
        techFamily(piece.required_print_technology) !== printerFamily
      ) {
        skipped.push({
          piece_id: piece.piece_id,
          piece_name: piece.piece_name,
          reason: `needs ${piece.required_print_technology}, printer is ${printer.print_technology}`,
        });
        continue;
      }
      const nozzle = resolveNozzleFor(
        piece.required_nozzle_diameter_mm,
        piece.required_nozzle_material
      );
      // Seed the schedulable metadata from the piece's QUOTE (the time + grams
      // the operator entered while costing it in the Orders page). These are
      // assumed values — a later g-code drop or manual edit overrides them —
      // but they let a quoted piece land 'ready' in this single click instead
      // of parking at 'assigned' until someone re-types numbers that already
      // exist. Pieces with no quote keep the old NULL wipe.
      const assumed = quoteAssumedMeta(piece.cost_inputs);
      // For a resin piece the quote's quantity is MILLILITRES, not grams — the
      // piece grid's quantity column carries the row's own unit. So it seeds the
      // resin draw, and picks the tank that can cover it.
      const pieceIsResin = isResinTech(piece.required_print_technology);
      const tank = pieceIsResin ? resolveTankFor(assumed.grams, piece.required_color) : null;
      // The piece IS assigned either way — it just can't reach 'ready' without a
      // tank, and until now it parked at 'assigned' with nothing said. Silence is
      // the specific thing that made every earlier resin gap so expensive to
      // diagnose, so name the blocker instead of leaving the operator to infer it.
      if (pieceIsResin && !tank) {
        const wanted = (piece.required_color ?? "").trim();
        notes.push({
          piece_id: piece.piece_id,
          piece_name: piece.piece_name,
          note: resinTanks.length === 0
            ? "assigned, but no usable resin tank exists — add one to reach ready"
            : wanted && !resinTanks.some((t) => colorCompatible(wanted, t.resin_color))
              ? `assigned, but no ${wanted} resin tank is available — it needs one to reach ready`
              : "assigned, but no resin tank has enough volume left — it needs one to reach ready",
        });
      }
      const key = `${nozzle ?? ""}|${tank ?? ""}|${assumed.minutes ?? ""}|${assumed.grams ?? ""}|${pieceIsResin ? "r" : "f"}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          nozzle,
          tank,
          minutes: assumed.minutes,
          // Resin's quantity rides the resin column; filament's the gram column.
          grams: pieceIsResin ? null : assumed.grams,
          ml: pieceIsResin ? assumed.grams : null,
          isResin: pieceIsResin,
          ids: [],
        };
        groups.set(key, g);
      }
      g.ids.push(piece.piece_id);
      if (piece.requires_multicolor && piece.cost_inputs?.grams?.length) {
        const slotGrams = piece.cost_inputs.grams.map((v) => Number(v));
        if (slotGrams.every((n) => Number.isFinite(n) && n > 0)) {
          slotSeeds.push({ piece_id: piece.piece_id, grams: slotGrams });
        }
      }
      assignedCount++;
    }

    // ONE set-based UPDATE for the whole batch, not one per (nozzle, seed)
    // group. Grouping was already an improvement over a statement per piece,
    // but the group key carries the piece's OWN quote — `assumed.minutes` and
    // `assumed.grams` come from cost_inputs, which differ per piece — so on a
    // mixed batch the groups degenerate to one per piece and the "grouped"
    // write is a fan-out of N sequential round trips again. Two hundred pieces
    // with two hundred different quotes was two hundred UPDATEs.
    //
    // unnest() carries the per-piece values in as parallel arrays, so every
    // per-row decision below is IDENTICAL to the one the group loop made — same
    // COALESCE, same status CASE, same clearing of the other technology's
    // tooling — just resolved by the planner in a single statement.
    //
    // The SET expressions read op.* as the OLD row (Postgres evaluates them
    // against the pre-update tuple), which is exactly what the group version
    // relied on when it wrote COALESCE($4::uuid, assigned_nozzle_asset_id).
    const seedGroups = Array.from(groups.values()).filter((g) => g.ids.length > 0);
    if (seedGroups.length > 0) {
      const upIds: string[] = [];
      const upNozzles: (string | null)[] = [];
      const upMinutes: (number | null)[] = [];
      const upGrams: (number | null)[] = [];
      const upTanks: (string | null)[] = [];
      const upMls: (number | null)[] = [];
      const upIsResin: boolean[] = [];
      for (const g of seedGroups) {
        for (const id of g.ids) {
          upIds.push(id);
          upNozzles.push(g.nozzle);
          upMinutes.push(g.minutes);
          upGrams.push(g.grams);
          upTanks.push(g.tank);
          upMls.push(g.ml);
          upIsResin.push(g.isResin);
        }
      }
      await this.db.query(
        `
          UPDATE order_pieces op
          SET assigned_printer_id = $3,
              -- A piece holds the tooling of ONE technology, and assigning it
              -- clears the other's outright. COALESCE alone only ever ADDED:
              -- a piece that was FDM and became resin kept its old nozzle id
              -- forever, because a resin assign passes NULL and COALESCE reads
              -- that as "leave it". Nothing downstream could tell that stale id
              -- from a real one, so the schedule board drew a nozzle lane for a
              -- machine with no nozzle -- correctly rendering junk data.
              assigned_nozzle_asset_id = CASE
                WHEN s.is_resin THEN NULL
                ELSE COALESCE(s.nozzle, op.assigned_nozzle_asset_id)
              END,
              resin_tank_id = CASE
                WHEN s.is_resin THEN COALESCE(s.tank, op.resin_tank_id)
                ELSE NULL
              END,
              slicer_file_url            = NULL,
              slicer_file_uploaded_at    = NULL,
              slicer_print_time_minutes  = s.minutes,
              slicer_filament_used_grams = s.grams,
              slicer_resin_used_ml       = s.ml,
              status = CASE
                -- Each technology's own prerequisites, matching
                -- chk_ready_requires_core_data exactly. Resin has no nozzle, so
                -- the old nozzle-only test left every resin piece at its previous
                -- status while stamping the printer — assigned in the UI, pending
                -- in the database.
                WHEN op.required_print_technology IN ('MSLA', 'SLA') THEN
                  CASE
                    WHEN s.minutes IS NOT NULL AND s.ml IS NOT NULL
                     AND COALESCE(s.tank, op.resin_tank_id) IS NOT NULL THEN 'ready'
                    ELSE 'assigned'
                  END
                -- 'ready' needs (printer, nozzle, time, grams); 'assigned' needs
                -- printer + nozzle. If no nozzle could be resolved, leave the
                -- status as-is rather than risk an inconsistent 'assigned'.
                WHEN COALESCE(s.nozzle, op.assigned_nozzle_asset_id) IS NOT NULL
                 AND s.minutes IS NOT NULL AND s.grams IS NOT NULL THEN 'ready'
                WHEN COALESCE(s.nozzle, op.assigned_nozzle_asset_id) IS NOT NULL THEN 'assigned'
                ELSE op.status
              END
          FROM unnest($2::uuid[], $4::uuid[], $5::int[], $6::numeric[], $7::uuid[], $8::numeric[], $9::boolean[])
            AS s(piece_id, nozzle, minutes, grams, tank, ml, is_resin)
          WHERE op.company_id = $1
            AND op.piece_id = s.piece_id
        `,
        [companyId, upIds, printerId, upNozzles, upMinutes, upGrams, upTanks, upMls, upIsResin]
      );

      // Resin draws from a tank, never a spool, so any spool reservation the
      // piece carried from a previous FDM life is released here. Left in place
      // it holds grams against stock that will never be consumed AND puts the
      // piece on the Spool pivot's lanes — the same stale-data problem as the
      // nozzle above, one table over.
      const resinIds = upIds.filter((_, i) => upIsResin[i]);
      if (resinIds.length > 0) {
        await this.db.query(
          `DELETE FROM order_piece_spools
            WHERE company_id = $1 AND piece_id = ANY($2::uuid[])`,
          [companyId, resinIds]
        );
      }
    }

    // Multicolor: mirror the quote's per-slot grams into the color slots (only
    // where still unset, and only when the quote has one figure per slot) so
    // the spool planner sees the same assumed demand.
    //
    // Also ONE statement. This used to be a COUNT plus one UPDATE per SLOT per
    // piece — a four-colour piece cost five sequential round trips, so five
    // hundred of them cost two and a half thousand. The `eligible` CTE is the
    // set-based spelling of the guard that was `if (count !== grams.length)
    // continue`: a piece is seeded only when its slot count matches the number
    // of figures its quote carries, so a quote that disagrees with the piece is
    // skipped whole rather than half-applied.
    if (slotSeeds.length > 0) {
      const seedPieceIds: string[] = [];
      const seedSeq: number[] = [];
      const seedGrams: number[] = [];
      for (const seed of slotSeeds) {
        for (let i = 0; i < seed.grams.length; i++) {
          seedPieceIds.push(seed.piece_id);
          seedSeq.push(i + 1);
          seedGrams.push(seed.grams[i]!);
        }
      }
      await this.db.query(
        `
          WITH seed AS (
            SELECT * FROM unnest($2::uuid[], $3::int[], $4::numeric[])
              AS t(piece_id, seq, grams)
          ),
          have AS (
            SELECT piece_id, COUNT(*) AS n
              FROM order_piece_color_slots
             WHERE company_id = $1 AND piece_id = ANY($2::uuid[])
             GROUP BY piece_id
          ),
          want AS (
            SELECT piece_id, COUNT(*) AS n FROM seed GROUP BY piece_id
          ),
          eligible AS (
            SELECT h.piece_id FROM have h JOIN want w ON w.piece_id = h.piece_id AND w.n = h.n
          ),
          ordered AS (
            SELECT color_slot_id, piece_id,
                   ROW_NUMBER() OVER (PARTITION BY piece_id ORDER BY sequence_order) AS rn
              FROM order_piece_color_slots
             WHERE company_id = $1 AND piece_id IN (SELECT piece_id FROM eligible)
          )
          UPDATE order_piece_color_slots cs
             SET slicer_grams = seed.grams
            FROM ordered o
            JOIN seed ON seed.piece_id = o.piece_id AND seed.seq = o.rn
           WHERE cs.company_id = $1
             AND cs.color_slot_id = o.color_slot_id
             AND cs.slicer_grams IS NULL
        `,
        [companyId, seedPieceIds, seedSeq, seedGrams]
      );
    }

    // ── Packed plates in the same batch ──────────────────────────────────────
    //
    // A bed is a piece as far as ASSIGNING is concerned: it takes one printer,
    // mounts one nozzle (or pours from one tank) and is gated on the same
    // metadata. It runs down the identical resolution built above —
    // `resolveNozzleFor`, `resolveTankFor`, `printerFamily` — rather than a
    // parallel copy, because a bed resolving hardware differently from the
    // pieces sitting ON it is the kind of divergence nobody notices until a
    // plate is scheduled onto a nozzle the printer cannot mount.
    //
    // Beds were previously excluded from this route entirely, and the cost was
    // not just the missing button: a bed only enters the fleet packer at
    // status 'ready' with a printer, so with no bulk path they had to be
    // assigned one modal at a time. In practice they never accumulated, and
    // auto-schedule — which has handled beds all along — looked like it was
    // ignoring them.
    //
    // Two rules differ from a piece and both come from BedsService.assign:
    //   · print data is SEEDED from the constituent pieces' quotes (Σ time,
    //     Σ quantity) when the plate has none, so one click still reaches
    //     'ready'. A packed plate prints faster than its parts run
    //     sequentially, so the sum is a deliberate over-estimate to trim.
    //   · a resin plate's tank defaults to the one its pieces were costed
    //     against — a plate pours from one vat, so the first is the honest
    //     answer — before falling back to the auto-resolver.
    let bedsAssigned = 0;
    if (bedIds.length > 0) {
      const bedRes = await this.db.query<{
        bed_id: string;
        bed_name: string;
        status: string;
        required_print_technology: string | null;
        required_filament_material: string | null;
        required_nozzle_diameter_mm: number | null;
        required_nozzle_material: string | null;
        slicer_print_time_minutes: number | null;
        slicer_filament_used_grams: number | null;
        slicer_resin_used_ml: number | null;
        resin_tank_id: string | null;
      }>(
        `SELECT bed_id, bed_name, status, required_print_technology,
                required_filament_material, required_nozzle_diameter_mm,
                required_nozzle_material, slicer_print_time_minutes,
                slicer_filament_used_grams, slicer_resin_used_ml, resin_tank_id
           FROM print_beds
          WHERE company_id = $1 AND bed_id = ANY($2::uuid[])`,
        [companyId, bedIds]
      );

      // Every plate's constituent quotes in ONE round trip. Per-bed this was a
      // query inside the loop, which is the fan-out this route was rebuilt to
      // remove — five hundred plates would have been five hundred sequential
      // awaits before a single row was written.
      const bedSeeds = new Map<string, { minutes: number; quantity: number }>();
      const bedTankSeed = new Map<string, string>();
      // print_beds has no required_color of its own — unlike the nozzle spec,
      // colour was never duplicated onto the plate — so a plate's colour demand
      // is the colour of the parts packed on it. Carried here because the tank
      // auto-resolver MUST see it: a resin part comes out the colour of the
      // liquid it cured from and there is no correcting it afterwards, so
      // pouring a blue plate from the yellow vat scraps every part on it.
      // printerAvailability already derives the plate's colour this way when it
      // filters the tank list; resolving the tank without it here would have
      // let the auto-pick land on a vat the picker had just ruled out.
      const bedColorSeed = new Map<string, string>();
      const childRes = await this.db.query<{
        bed_id: string;
        cost_inputs: { grams?: string[]; time?: string } | null;
        resin_tank_id: string | null;
        required_color: string | null;
      }>(
        `SELECT bed_id, cost_inputs, resin_tank_id, required_color
           FROM order_pieces
          WHERE company_id = $1 AND bed_id = ANY($2::uuid[])`,
        [companyId, bedIds]
      );
      for (const row of childRes.rows) {
        const acc = bedSeeds.get(row.bed_id) ?? { minutes: 0, quantity: 0 };
        const q = quoteAssumedMeta(row.cost_inputs);
        if (q.minutes != null) acc.minutes += q.minutes;
        if (q.grams != null) acc.quantity += q.grams;
        bedSeeds.set(row.bed_id, acc);
        if (row.resin_tank_id && !bedTankSeed.has(row.bed_id)) {
          bedTankSeed.set(row.bed_id, row.resin_tank_id);
        }
        const color = (row.required_color ?? "").trim();
        if (color && !bedColorSeed.has(row.bed_id)) bedColorSeed.set(row.bed_id, color);
      }

      const upBedIds: string[] = [];
      const upBedNozzles: (string | null)[] = [];
      const upBedMinutes: (number | null)[] = [];
      const upBedGrams: (number | null)[] = [];
      const upBedTanks: (string | null)[] = [];
      const upBedMls: (number | null)[] = [];
      const upBedIsResin: boolean[] = [];

      for (const bed of bedRes.rows) {
        // Mirrors BedsService.assign's status guard, reported instead of thrown:
        // one plate the operator cannot assign must not cost them the batch.
        if (bed.status !== "pending" && bed.status !== "assigned" && bed.status !== "ready") {
          skipped.push({
            piece_id: bed.bed_id,
            piece_name: bed.bed_name,
            reason: bed.status === "scheduled" ? "scheduled — unschedule it first" : `bed is '${bed.status}'`,
          });
          continue;
        }
        if (
          bed.required_print_technology &&
          printerFamily &&
          techFamily(bed.required_print_technology) !== printerFamily
        ) {
          skipped.push({
            piece_id: bed.bed_id,
            piece_name: bed.bed_name,
            reason: `needs ${bed.required_print_technology}, printer is ${printer.print_technology}`,
          });
          continue;
        }
        const bedIsResin = isResinTech(bed.required_print_technology);
        // Printer compatibility is checked against the filament material, so an
        // FDM plate without one cannot be placed. Resin has no filament at all —
        // its material identity is the tank — so the check is asked only of the
        // technology that has an answer.
        if (!bedIsResin && !bed.required_filament_material) {
          skipped.push({
            piece_id: bed.bed_id,
            piece_name: bed.bed_name,
            reason: "choose a filament material for this bed first — compatibility is checked against it",
          });
          continue;
        }

        const seed = bedSeeds.get(bed.bed_id);
        const seedMinutes = seed && seed.minutes > 0 ? Math.round(seed.minutes) : null;
        const seedQuantity = seed && seed.quantity > 0 ? Math.round(seed.quantity * 100) / 100 : null;
        const minutes = bed.slicer_print_time_minutes ?? seedMinutes;
        const currentQuantity = bedIsResin ? bed.slicer_resin_used_ml : bed.slicer_filament_used_grams;
        const quantity = currentQuantity ?? seedQuantity;

        const nozzle = bedIsResin
          ? null
          : resolveNozzleFor(bed.required_nozzle_diameter_mm, bed.required_nozzle_material);
        const tank = bedIsResin
          ? (bed.resin_tank_id
              ?? bedTankSeed.get(bed.bed_id)
              ?? resolveTankFor(quantity, bedColorSeed.get(bed.bed_id) ?? null))
          : null;
        // Same silence-is-expensive rule the piece arm applies: the plate IS
        // assigned, it simply cannot reach 'ready' without a vat, and saying so
        // beats leaving the operator to infer it from a status that did not move.
        if (bedIsResin && !tank) {
          // The same three-way message the piece arm gives, because the three
          // have different fixes: buy a tank, fetch the right colour, or top one
          // up. "No tank available" sends the operator looking at all three.
          const wantedColor = bedColorSeed.get(bed.bed_id) ?? "";
          notes.push({
            piece_id: bed.bed_id,
            piece_name: bed.bed_name,
            note: resinTanks.length === 0
              ? "assigned, but no usable resin tank exists — add one to reach ready"
              : wantedColor && !resinTanks.some((t) => colorCompatible(wantedColor, t.resin_color))
                ? `assigned, but no ${wantedColor} resin tank is available — it needs one to reach ready`
                : "assigned, but no resin tank has enough volume left — it needs one to reach ready",
          });
        }

        upBedIds.push(bed.bed_id);
        upBedNozzles.push(nozzle);
        upBedMinutes.push(minutes);
        upBedGrams.push(bedIsResin ? null : quantity);
        upBedTanks.push(tank);
        upBedMls.push(bedIsResin ? quantity : null);
        upBedIsResin.push(bedIsResin);
        bedsAssigned++;
      }

      if (upBedIds.length > 0) {
        // One statement for the whole batch, the same unnest() shape the piece
        // write uses and for the same reason: the seeded time/quantity come from
        // each plate's OWN constituent quotes, so any grouping degenerates to one
        // statement per plate.
        //
        // The status CASE is BedsService.assign's, transcribed rather than
        // reinvented, so one plate cannot become 'ready' by two different rules.
        // (print_beds carries no readiness CHECK — 2026-06-30 left that block
        // commented and made bed readiness application-enforced — so unlike the
        // piece path a mismatch here would be silently wrong rather than a loud
        // constraint violation. That makes matching it more important, not less.)
        //
        // ONE DELIBERATE DIVERGENCE, in the quantity columns.
        // BedsService.assign writes `COALESCE($7, slicer_filament_used_grams)`
        // with $7 NULL for resin, so a plate KEEPS filament grams it can never
        // consume; the arms below CLEAR the other technology's quantity outright,
        // matching what the piece write already does. Stale cross-technology data
        // is not inert here — it is what drew a 0.40mm nozzle lane on a resin
        // board from perfectly real columns. Worth correcting in
        // BedsService.assign too, which is why this says so rather than quietly
        // differing.
        await this.db.query(
          `
            UPDATE print_beds pb
            SET assigned_printer_id       = $3,
                -- A plate carries the tooling of ONE technology; assigning it
                -- clears the other's, exactly as the piece write does. COALESCE
                -- alone only ever added, so a plate that changed technology kept
                -- a nozzle id no machine could mount.
                assigned_nozzle_asset_id  = CASE
                  WHEN s.is_resin THEN NULL
                  ELSE COALESCE(s.nozzle, pb.assigned_nozzle_asset_id)
                END,
                resin_tank_id             = CASE
                  WHEN s.is_resin THEN COALESCE(s.tank, pb.resin_tank_id)
                  ELSE NULL
                END,
                slicer_print_time_minutes  = COALESCE(s.minutes, pb.slicer_print_time_minutes),
                slicer_filament_used_grams = CASE
                  WHEN s.is_resin THEN NULL
                  ELSE COALESCE(s.grams, pb.slicer_filament_used_grams)
                END,
                slicer_resin_used_ml       = CASE
                  WHEN s.is_resin THEN COALESCE(s.ml, pb.slicer_resin_used_ml)
                  ELSE NULL
                END,
                status = CASE
                  WHEN s.is_resin THEN
                    CASE WHEN COALESCE(s.minutes, pb.slicer_print_time_minutes) IS NOT NULL
                          AND COALESCE(s.ml, pb.slicer_resin_used_ml) IS NOT NULL
                          AND COALESCE(s.tank, pb.resin_tank_id) IS NOT NULL
                         THEN 'ready' ELSE 'assigned' END
                  WHEN COALESCE(s.nozzle, pb.assigned_nozzle_asset_id) IS NOT NULL
                   AND COALESCE(s.minutes, pb.slicer_print_time_minutes) IS NOT NULL
                   AND COALESCE(s.grams, pb.slicer_filament_used_grams) IS NOT NULL THEN 'ready'
                  WHEN COALESCE(s.nozzle, pb.assigned_nozzle_asset_id) IS NOT NULL THEN 'assigned'
                  ELSE pb.status
                END
            FROM unnest($2::uuid[], $4::uuid[], $5::int[], $6::numeric[], $7::uuid[], $8::numeric[], $9::boolean[])
              AS s(bed_id, nozzle, minutes, grams, tank, ml, is_resin)
            WHERE pb.company_id = $1
              AND pb.bed_id = s.bed_id
          `,
          [companyId, upBedIds, printerId, upBedNozzles, upBedMinutes, upBedGrams, upBedTanks, upBedMls, upBedIsResin]
        );

        // No read-back of which plates reached 'ready'.
        //
        // The piece path re-reads because the caller CHAINS on it — one schedule
        // window per ready piece. A bed opens no such window (it schedules
        // through /beds/:id, and a batch of them belongs in Auto-schedule), so
        // the answer would have been a round trip per batch that nothing read.
        // If a count is ever wanted here, the Auto-schedule button already
        // reports it one click away, from the same gate the packer applies.
      }
    }

    // The picker chains straight into scheduling for pieces that are already
    // 'ready' (quote-seeded) — report which ones those are.
    const readyRes = pieceIds.length > 0
      ? await this.db.query<{ piece_id: string }>(
          `SELECT piece_id FROM order_pieces
            WHERE company_id = $1 AND piece_id = ANY($2::uuid[]) AND status = 'ready'`,
          [companyId, pieceIds]
        )
      : { rows: [] as { piece_id: string }[] };

    return {
      // Pieces and plates both count as assigned work — the operator selected
      // one list and expects one number back.
      assigned: assignedCount + bedsAssigned,
      skipped,
      notes,
      // PIECE ids only, and the name is load-bearing: the caller chains a
      // schedule window per id, and a bed does not open one. Plates that
      // reached 'ready' show up in the Auto-schedule count instead.
      ready_ids: readyRes.rows.map((r) => r.piece_id),
    };
  }

  // Bulk g-code drop: attach a slicer file (+ parsed time/grams) to each
  // already-assigned piece in one shot, flipping them to 'ready' when the
  // metadata is present. Pieces that are in production, or that don't yet have a
  // printer + nozzle, are skipped and reported. 'ready' requires (printer,
  // nozzle, slicer time, filament grams) per chk_ready_requires_core_data — so
  // a drop whose parse yielded no time/grams lands the piece at 'assigned'.
  async attachSlicer(
    companyId: string,
    items: {
      piece_id: string;
      // null in headers-only mode: the text g-code was parsed locally and never
      // uploaded, so there's no stored file — just the metadata below.
      slicer_file_url: string | null;
      slicer_print_time_minutes?: number | undefined;
      slicer_filament_used_grams?: number | undefined;
      // Resin's counterparts. A resin print is measured in millilitres and draws
      // from one tank; without these the simple path could never take a resin
      // piece past 'assigned', which is what forced resin through the
      // assignment wizard instead of this flow.
      slicer_resin_used_ml?: number | undefined;
      resin_tank_id?: string | undefined;
    }[]
  ) {
    const ids = items.map((i) => i.piece_id);
    const rows = await this.db.query<{
      piece_id: string;
      piece_name: string;
      status: string;
      assigned_printer_id: string | null;
      assigned_nozzle_asset_id: string | null;
      required_print_technology: string | null;
      resin_tank_id: string | null;
    }>(
      `
        SELECT piece_id, piece_name, status, assigned_printer_id, assigned_nozzle_asset_id,
               required_print_technology, resin_tank_id
        FROM order_pieces
        WHERE company_id = $1 AND piece_id = ANY($2::uuid[])
      `,
      [companyId, ids]
    );
    const byId = new Map(rows.rows.map((r) => [r.piece_id, r]));

    const updated: string[] = [];
    const skipped: { piece_id: string; piece_name: string; reason: string }[] = [];
    for (const item of items) {
      const piece = byId.get(item.piece_id);
      if (!piece) {
        skipped.push({ piece_id: item.piece_id, piece_name: item.piece_id, reason: "not found" });
        continue;
      }
      if (piece.status === "printing" || piece.status === "done") {
        skipped.push({ piece_id: piece.piece_id, piece_name: piece.piece_name, reason: "already in production" });
        continue;
      }
      // A resin printer has no nozzle, so requiring one here skipped every resin
      // piece with "assign a printer first" — the block that made this path
      // unusable for resin.
      const isResin = isResinTech(piece.required_print_technology);
      if (!piece.assigned_printer_id || (!isResin && !piece.assigned_nozzle_asset_id)) {
        skipped.push({ piece_id: piece.piece_id, piece_name: piece.piece_name, reason: "assign a printer first" });
        continue;
      }
      await this.db.query(
        `
          UPDATE order_pieces
          SET slicer_file_url            = $3,
              -- Keep the uploaded-at stamp consistent with the file's presence:
              -- headers-only attaches (null URL) leave it null.
              slicer_file_uploaded_at    = CASE WHEN $3::text IS NOT NULL THEN now() ELSE NULL END,
              slicer_print_time_minutes  = COALESCE($4, slicer_print_time_minutes),
              slicer_filament_used_grams = COALESCE($5, slicer_filament_used_grams),
              slicer_resin_used_ml       = COALESCE($6, slicer_resin_used_ml),
              resin_tank_id              = COALESCE($7, resin_tank_id),
              -- Readiness in the job's own unit. The resin arm ALSO requires a
              -- tank, matching chk_ready_requires_core_data exactly — promoting
              -- without one would trip the constraint rather than land 'assigned'.
              status                     = CASE
                WHEN COALESCE($4, slicer_print_time_minutes) IS NULL THEN 'assigned'
                WHEN required_print_technology IN ('MSLA', 'SLA') THEN
                  CASE WHEN COALESCE($6, slicer_resin_used_ml) IS NOT NULL
                        AND COALESCE($7, resin_tank_id) IS NOT NULL THEN 'ready' ELSE 'assigned' END
                WHEN COALESCE($5, slicer_filament_used_grams) IS NOT NULL THEN 'ready'
                ELSE 'assigned'
              END
          WHERE company_id = $1 AND piece_id = $2
        `,
        [
          companyId,
          item.piece_id,
          item.slicer_file_url,
          item.slicer_print_time_minutes ?? null,
          item.slicer_filament_used_grams ?? null,
          item.slicer_resin_used_ml ?? null,
          item.resin_tank_id ?? null,
        ]
      );
      updated.push(item.piece_id);
    }

    // Literal duplicates of the updated pieces (same order/name/spec, still
    // missing metadata) inherit the time/grams — one drop covers the whole run.
    const propagated = new Set<string>();
    for (const id of updated) {
      for (const dupId of await propagateSlicerMetaToDuplicatesTx(this.db, companyId, id)) {
        propagated.add(dupId);
      }
    }

    return { updated: updated.length, updated_ids: updated, skipped, propagated_ids: [...propagated] };
  }

  // Bulk-unassign: for the targeted pieces — selected individually and/or as
  // "everything on these printers" — whose status is BELOW printing
  // (assigned / ready / scheduled), drop the printer + nozzle, clear any
  // schedule window + the slicer file, release reserved spools, and return
  // them to 'pending'. Printing/done/failed/cancelled pieces are left
  // untouched. Clearing the slicer is deliberate: a re-assigned piece must start
  // clean rather than resurrect a previous session's g-code.
  async bulkUnassign(companyId: string, printerIds: string[], explicitPieceIds: string[] = []) {
    let unassigned = 0;
    await this.db.transaction(async (client) => {
      const found = await client.query<{ piece_id: string }>(
        `
          SELECT piece_id
          FROM order_pieces
          WHERE company_id = $1
            AND assigned_printer_id IS NOT NULL
            AND status IN ('assigned', 'ready', 'scheduled')
            AND (
              assigned_printer_id = ANY($2::uuid[])
              OR piece_id = ANY($3::uuid[])
            )
        `,
        [companyId, printerIds, explicitPieceIds]
      );
      const pieceIds = found.rows.map((r) => r.piece_id);
      if (pieceIds.length === 0) return;

      // Releasing the reservations fires the reserved-grams recalc trigger.
      await client.query(
        `DELETE FROM order_piece_spools WHERE company_id = $1 AND piece_id = ANY($2::uuid[])`,
        [companyId, pieceIds]
      );
      await client.query(
        `
          UPDATE order_pieces
          SET assigned_printer_id        = NULL,
              assigned_nozzle_asset_id   = NULL,
              -- Resin's counterparts of the nozzle + grams cleared above: an
              -- unassigned piece must not keep holding a tank, or its reservation
              -- lingers against a job that is no longer going to run.
              resin_tank_id              = NULL,
              slicer_resin_used_ml       = NULL,
              scheduled_start_at         = NULL,
              scheduled_end_at           = NULL,
              scheduled_at               = NULL,
              slicer_file_url            = NULL,
              slicer_file_uploaded_at    = NULL,
              slicer_print_time_minutes  = NULL,
              slicer_filament_used_grams = NULL,
              status                     = 'pending'
          WHERE company_id = $1 AND piece_id = ANY($2::uuid[])
        `,
        [companyId, pieceIds]
      );
      unassigned = pieceIds.length;
    });
    return { unassigned };
  }

  // ──────────────────────────────────────────────────────────────────
  // Mark a print FAILED (Simple mode).
  //
  // The operator stopped a print that went wrong, weighed the wasted filament,
  // and wants the piece back in the queue to try again. Unlike the Advanced
  // complete({outcome:'failed'}) — which leaves the piece in a terminal 'failed'
  // status consuming the full *planned* grams — this records the operator's
  // MEASURED waste per spool and re-queues the piece to either 'assigned' (keep
  // its printer/nozzle, re-drop the g-code) or 'pending' (a clean slate).
  //
  // Applies to a piece that's 'printing' OR already 'done' (the operator
  // realised after the fact it had actually failed). For a 'done' piece the
  // planned grams were already deducted from the spool at completion, so we
  // first restore them and then deduct the measured waste — the spool ends in
  // the same place as if the piece had been failed straight from 'printing'.
  //
  // `spoolWaste` carries one grams figure per reserved spool (multicolour
  // pieces reserve several). Spools the operator left out default to 0 waste.
  // ──────────────────────────────────────────────────────────────────
  async markFailed(
    companyId: string,
    userId: string,
    pieceId: string,
    requeueTo: "assigned" | "pending",
    spoolWaste: { spool_asset_id: string; grams: number }[],
    // Resin's counterpart of spoolWaste: the millilitres actually lost. A resin
    // job draws from one tank, so it's one figure. Omitted (undefined) means
    // "assume the whole planned draw", which is the physically likely outcome —
    // a failed resin print has usually already cured most of its resin into
    // scrap. The client pre-fills it so the operator confirms or overrides.
    resinWasteMl?: number,
    // Free text: what actually went wrong. Optional — an operator in a hurry
    // shouldn't be blocked from recording the loss — but when given it is the
    // most useful thing in the record, so it goes into the history line rather
    // than a field nobody reads.
    failureReason?: string
  ) {
    const piece = await this.loadRequeueablePiece(companyId, pieceId, requeueTo);

    // Sum the operator's waste per spool (a spool can only appear once per piece
    // via uq_piece_spool_asset, but fold defensively just in case).
    const wasteBySpool = new Map<string, number>();
    for (const w of spoolWaste) {
      wasteBySpool.set(w.spool_asset_id, (wasteBySpool.get(w.spool_asset_id) ?? 0) + w.grams);
    }
    // A 'done' piece already had its planned grams pulled from remaining at
    // completion; restore them so the net deduction equals the measured waste.
    const alreadyConsumed = piece.status === "done";

    // ── Resin: one tank, one volume ─────────────────────────────────────────
    const isResin = isResinTech(piece.required_print_technology);
    const plannedMl = piece.slicer_resin_used_ml != null ? Number(piece.slicer_resin_used_ml) : 0;
    // Default to the full planned draw, clamped to it: a failed print cannot
    // waste more resin than it was ever going to use.
    const resinMl = !isResin || !piece.resin_tank_id
      ? 0
      : Math.max(0, Math.min(plannedMl, resinWasteMl ?? plannedMl));

    await this.db.transaction(async (client) => {
      await this.reconcileMaterialTx(client, companyId, userId, piece, {
        wasteBySpool,
        resinMl,
        alreadyConsumed,
      });
      await this.requeuePieceTx(client, companyId, piece, requeueTo);
    });

    const totalWaste = [...wasteBySpool.values()].reduce((sum, g) => sum + g, 0);
    // The history line quotes the material's own unit — "180 ml resin wasted" is
    // the fact; "180 g" would be a different (and wrong) claim.
    const wastePhrase = isResin
      ? `${Math.round(resinMl)}ml resin wasted`
      : `${Math.round(totalWaste)}g filament wasted`;
    // The reason rides in the same history line as the loss, so the record reads
    // as one event: what failed, what it cost, and where the piece went.
    const reason = (failureReason ?? "").trim();
    await this.logFailure(
      companyId,
      piece.order_id,
      piece.order_number,
      pieceId,
      piece.piece_name,
      `Piece "${piece.piece_name}" marked failed — ${wastePhrase}, returned to ${requeueTo}.` +
        (reason ? ` Reason: ${reason}` : "")
    );

    return {
      piece_id: pieceId,
      status: requeueTo,
      waste_grams: totalWaste,
      waste_resin_ml: resinMl,
    };
  }

  // ──────────────────────────────────────────────────────────────────
  // Send a piece BACK TO PRODUCTION.
  //
  // The operator marked a piece done (or started it) and needs it back in the
  // queue — a mis-click, a part that turned out unacceptable on inspection, a
  // customer who changed the spec after the fact. This is markFailed's sibling
  // and shares its whole mechanism; the one difference is that NOTHING was
  // wasted, so the planned material is restored in full and no spoilage is
  // booked to the ledger.
  //
  // That distinction is the reason this is its own operation rather than a
  // status write from the UI. A done piece has already had its grams/millilitres
  // pulled from stock and its printer released; setting `status` back by hand
  // would leave the material permanently deducted for a print that is about to
  // be run again — the stock figure and the shelf would silently disagree, and
  // every cost the shop computes downstream would inherit the error.
  // ──────────────────────────────────────────────────────────────────
  async sendBackToProduction(
    companyId: string,
    pieceId: string,
    requeueTo: "assigned" | "pending"
  ) {
    const piece = await this.loadRequeueablePiece(companyId, pieceId, requeueTo);

    // A 'done' piece had its planned material consumed at completion; restore it
    // in full. A 'printing' piece was never deducted, so there is nothing to give
    // back — the same rule markFailed applies.
    const alreadyConsumed = piece.status === "done";

    await this.db.transaction(async (client) => {
      await this.reconcileMaterialTx(client, companyId, null, piece, {
        // No waste: this is a piece going back to be printed, not a loss.
        wasteBySpool: new Map(),
        resinMl: 0,
        alreadyConsumed,
      });
      await this.requeuePieceTx(client, companyId, piece, requeueTo);
    });

    await this.logFailure(
      companyId,
      piece.order_id,
      piece.order_number,
      pieceId,
      piece.piece_name,
      `Piece "${piece.piece_name}" sent back to production (${requeueTo})` +
        `${alreadyConsumed ? " — its reserved material was returned to stock" : ""}.`
    );

    return { piece_id: pieceId, status: requeueTo };
  }

  /**
   * Load the piece both re-queue paths operate on, and enforce the rules they
   * share: only a print that is actually in or past the machine can be sent
   * back, a bed piece is handled at bed level, and 'assigned' needs a printer to
   * return to.
   */
  private async loadRequeueablePiece(
    companyId: string,
    pieceId: string,
    requeueTo: "assigned" | "pending"
  ): Promise<RequeueablePiece> {
    const pieceRes = await this.db.query<RequeueablePiece>(
      `
        SELECT op.piece_id, op.order_id, o.order_number, op.piece_name,
               op.status, op.assigned_printer_id, op.bed_id,
               op.required_print_technology, op.resin_tank_id, op.slicer_resin_used_ml
          FROM order_pieces op
          JOIN orders o ON o.order_id = op.order_id AND o.company_id = op.company_id
         WHERE op.company_id = $1 AND op.piece_id = $2
      `,
      [companyId, pieceId]
    );
    const piece = pieceRes.rows[0];
    if (!piece) {
      throw new NotFoundException("Piece not found.");
    }
    if (piece.status !== "printing" && piece.status !== "done") {
      throw new ConflictException(
        `Only a printing or completed piece can be returned to the queue (current: '${piece.status}').`
      );
    }
    if (piece.bed_id) {
      throw new BadRequestException(
        "This piece is packed on a bed — schedule or move the whole bed instead."
      );
    }
    if (requeueTo === "assigned" && !piece.assigned_printer_id) {
      throw new BadRequestException(
        "This piece has no assigned printer to return to — send it back to pending instead."
      );
    }
    return piece;
  }

  /**
   * Reconcile a piece's material back to the spool(s) / tank it drew from, given
   * what was actually lost.
   *
   * One function for both re-queue paths, because they are the same act with
   * different numbers: the net change to stock is `restore − waste`, where
   * `restore` is the planned draw a completed piece already had deducted, and
   * `waste` is what the operator measured. markFailed passes real waste;
   * sendBackToProduction passes none, which reduces to a pure restore. Keeping
   * this in one place is what stops the two from drifting into disagreeing about
   * what a spool's remaining grams mean.
   *
   * Spoilage is booked to the ledger from here too (DR Material Waste / CR
   * Inventory), inside the caller's transaction — so the loss record, its journal
   * entry and the re-queue are all-or-nothing. Zero waste books nothing.
   */
  private async reconcileMaterialTx(
    client: PoolClient,
    companyId: string,
    userId: string | null,
    piece: RequeueablePiece,
    measured: {
      /** Grams lost per reserved spool. Empty = nothing was wasted. */
      wasteBySpool: Map<string, number>;
      /** Millilitres of resin lost (already clamped to the planned draw). */
      resinMl: number;
      /** Whether the planned draw was already deducted (i.e. the piece is done). */
      alreadyConsumed: boolean;
    }
  ): Promise<void> {
    const { wasteBySpool, resinMl, alreadyConsumed } = measured;

    // ── Resin: one tank, one volume ─────────────────────────────────────────
    const isResin = isResinTech(piece.required_print_technology);
    const resinTankId = piece.resin_tank_id;
    if (isResin && resinTankId) {
      const plannedMl = piece.slicer_resin_used_ml != null ? Number(piece.slicer_resin_used_ml) : 0;
      const restore = alreadyConsumed ? plannedMl : 0;
      const delta = restore - resinMl;
      if (delta !== 0) {
        await client.query(
          `
            UPDATE asset_stock
               SET remaining_volume_ml = GREATEST(0, COALESCE(remaining_volume_ml, 0) + $2),
                   status = CASE
                     WHEN GREATEST(0, COALESCE(remaining_volume_ml, 0) + $2) <= 0 THEN 'empty'
                     WHEN status = 'empty' THEN 'available'
                     ELSE status
                   END
             WHERE asset_id = $1
          `,
          [resinTankId, delta]
        );
      }
      if (resinMl > 0) {
        await this.finance.recordResinWaste(client, companyId, userId, {
          pieceId: piece.piece_id,
          orderId: piece.order_id,
          tankAssetId: resinTankId,
          ml: resinMl,
        });
      }
    }

    // ── Filament: one row per reserved spool ────────────────────────────────
    const reserved = await client.query<{ spool_asset_id: string; planned_grams: string | null }>(
      `SELECT spool_asset_id, planned_grams
         FROM order_piece_spools
        WHERE company_id = $1 AND piece_id = $2`,
      [companyId, piece.piece_id]
    );
    // Only spools actually reserved for this piece have their stock touched;
    // collect the same set (with waste > 0) to persist + book as loss below.
    const wasteEvents: { spoolAssetId: string; grams: number }[] = [];
    for (const r of reserved.rows) {
      const planned = Number(r.planned_grams) || 0;
      const waste = wasteBySpool.get(r.spool_asset_id) ?? 0;
      if (waste > 0) wasteEvents.push({ spoolAssetId: r.spool_asset_id, grams: waste });
      const restore = alreadyConsumed ? planned : 0;
      // Net change to the spool's physical remaining grams. Floored at 0 by
      // GREATEST so an over-estimate can't drive a spool negative.
      const delta = restore - waste;
      await client.query(
        `
          UPDATE asset_stock
             SET remaining_grams = GREATEST(0, COALESCE(remaining_grams, 0) + $2),
                 status = CASE
                   WHEN GREATEST(0, COALESCE(remaining_grams, 0) + $2) <= 0 THEN 'empty'
                   WHEN status = 'empty' THEN 'available'
                   ELSE status
                 END
           WHERE asset_id = $1
        `,
        [r.spool_asset_id, delta]
      );
    }
    // Reads asset_instances cost, not the asset_stock grams we just changed, so
    // ordering is irrelevant. Early-returns on an empty list.
    await this.finance.recordFilamentWaste(client, companyId, userId, {
      pieceId: piece.piece_id,
      orderId: piece.order_id,
      wasteBySpool: wasteEvents,
    });
  }

  /**
   * Put a piece back in the queue: release everything it was holding and clear
   * every stamp a fresh print run must not inherit.
   *
   * 'assigned' keeps the printer + nozzle (+ tank) so the operator just re-drops
   * the g-code; 'pending' wipes them for a clean slate. Everything else clears
   * either way — a re-print starts from the same place a first print does.
   */
  private async requeuePieceTx(
    client: PoolClient,
    companyId: string,
    piece: RequeueablePiece,
    requeueTo: "assigned" | "pending"
  ): Promise<void> {
    const pieceId = piece.piece_id;
    // Drop the reservation rows BEFORE flipping status. Deleting them lets the
    // reserved-grams recalc trigger release the held grams; doing it first also
    // means the trigger that fires on a 'done'→non-terminal flip finds no rows
    // to re-reserve.
    await client.query(
      `DELETE FROM order_piece_spools WHERE company_id = $1 AND piece_id = $2`,
      [companyId, pieceId]
    );
    // Free the printer this piece was holding (no-op for a 'done' piece whose
    // printer was already released at completion).
    if (piece.assigned_printer_id) {
      await releasePrinterForPieceTx(client, companyId, piece.assigned_printer_id, pieceId);
    }
    // One statement for both targets: the columns 'pending' additionally clears
    // are the ones that name a machine, and they're cleared by a CASE on the
    // target rather than by a second near-identical UPDATE that has to be kept
    // in step with the first.
    //
    // fulfilment_status resets to 'none' unconditionally. A piece heading back to
    // the queue is not "ready for shipping" — leaving the old value behind meant
    // a re-queued piece silently re-entered shipping the moment it completed
    // again, wearing a stage it never re-earned.
    const toPending = requeueTo === "pending";
    await client.query(
      `
        UPDATE order_pieces
           SET status                        = $3,
               assigned_printer_id           = CASE WHEN $4 THEN NULL ELSE assigned_printer_id END,
               assigned_nozzle_asset_id      = CASE WHEN $4 THEN NULL ELSE assigned_nozzle_asset_id END,
               resin_tank_id                 = CASE WHEN $4 THEN NULL ELSE resin_tank_id END,
               fulfilment_status             = 'none',
               slicer_file_url               = NULL,
               slicer_file_uploaded_at       = NULL,
               slicer_print_time_minutes     = NULL,
               slicer_filament_used_grams    = NULL,
               slicer_resin_used_ml          = NULL,
               post_process_state            = NULL,
               post_process_state_entered_at = NULL,
               scheduled_at                  = NULL,
               scheduled_start_at            = NULL,
               scheduled_end_at              = NULL,
               print_started_at              = NULL,
               print_completed_at            = NULL,
               actual_print_time_minutes     = NULL,
               actual_filament_used_grams    = NULL
         WHERE company_id = $1 AND piece_id = $2
      `,
      [companyId, pieceId, requeueTo, toPending]
    );
    // Re-derive the order's rollup status inside the same transaction.
    await recomputeOrderStatusTx(client, companyId, piece.order_id);
  }

  /** Best-effort failure log into the shared order_history feed. Mirrors the
   *  pattern in TimeStateService — a missing/failed log never blocks the action. */
  private async logFailure(
    companyId: string,
    orderId: string,
    orderNumber: string,
    pieceId: string,
    pieceName: string,
    description: string
  ): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO order_history
           (company_id, entity_type, event_type, order_id, order_number, piece_id, piece_name, description)
         VALUES ($1, 'piece', 'failed', $2, $3, $4, $5, $6)`,
        [companyId, orderId, orderNumber, pieceId, pieceName, description]
      );
    } catch { /* ignore — history is non-critical */ }
  }

  // Informational printer availability for the assign picker — every printer in
  // the fleet (no filtering), each with: when it next goes idle (end of the
  // block running now, else now), and how many free minutes remain in the
  // chosen window. Pure wall-clock math against the scheduled/printing blocks;
  // no constraints, no optimization.
  async printerAvailability(
    companyId: string,
    horizon: "day" | "week" | "month" | "deadline",
    deadlineIso?: string,
    pieceIds?: string[],
    /** Plates in the selection. One for the single-bed window, many when a bulk
     *  selection mixes plates with loose pieces — the picker must only offer
     *  printers compatible with EVERY item, so both kinds constrain it here. */
    bedIds: string[] = []
  ) {
    const now = new Date();
    const dayMs = 24 * 60 * 60 * 1000;
    let windowEnd: Date;
    if (horizon === "day") windowEnd = new Date(now.getTime() + dayMs);
    else if (horizon === "month") windowEnd = new Date(now.getTime() + 30 * dayMs);
    else if (horizon === "deadline") {
      const d = deadlineIso ? new Date(deadlineIso) : null;
      windowEnd = d && !Number.isNaN(d.getTime()) && d.getTime() > now.getTime() ? d : new Date(now.getTime() + 7 * dayMs);
    } else {
      windowEnd = new Date(now.getTime() + 7 * dayMs); // week (default)
    }

    // Combined requirements across the selected pieces. The picker must only
    // surface printers compatible with EVERY one of them.
    let requireMulticolor = false;
    const techFamilies = new Set<string>();
    // Distinct NOZZLE requirements across the selection. A single piece yields
    // one (or zero, if it states no nozzle); a bulk selection of three pieces
    // needing three different nozzles yields three — and the picker then asks
    // the operator to pick a nozzle for each. Keyed by diameter+material so the
    // same need across pieces collapses to one requirement (with a count).
    const nozzleReq = new Map<string, { key: string; diameter_mm: number | null; material: string | null; label: string; piece_count: number }>();
    const reqKey = (dia: number | null, mat: string | null) =>
      `${dia != null ? Number(dia) : ""}|${(mat ?? "").trim().toLowerCase()}`;
    // Resin's counterpart of a nozzle requirement: the colours the selection
    // demands. Distinct, case-insensitive, blanks dropped (a piece with no
    // colour constrains nothing). Only resin pieces contribute — an FDM piece
    // gets its colour from a spool, which is a different mechanism entirely.
    const resinColorSet = new Map<string, string>();
    if (pieceIds && pieceIds.length > 0) {
      const reqRes = await this.db.query<{
        required_print_technology: string | null;
        required_multicolor_capable: boolean | null;
        requires_multicolor: boolean | null;
        required_nozzle_diameter_mm: number | null;
        required_nozzle_material: string | null;
        required_color: string | null;
      }>(
        `
          SELECT required_print_technology, required_multicolor_capable, requires_multicolor,
                 required_nozzle_diameter_mm, required_nozzle_material, required_color
          FROM order_pieces
          WHERE company_id = $1 AND piece_id = ANY($2::uuid[])
        `,
        [companyId, pieceIds]
      );
      for (const r of reqRes.rows) {
        if (r.required_print_technology) techFamilies.add(techFamily(r.required_print_technology));
        if (r.required_multicolor_capable || r.requires_multicolor) requireMulticolor = true;
        if (isResinTech(r.required_print_technology)) {
          const c = (r.required_color ?? "").trim();
          if (c) resinColorSet.set(c.toLowerCase(), c);
        }
        // A resin printer has no nozzle, so a resin piece must never contribute a
        // nozzle requirement — otherwise the picker asks for a nozzle no resin
        // machine can offer and returns an empty list. Checked on the TECHNOLOGY
        // rather than on the columns being empty, because a piece switched from
        // FDM to MSLA/SLA can still carry its old diameter/material.
        if (isResinTech(r.required_print_technology)) continue;
        // Only pieces that actually state a nozzle need constrain the picker.
        const dia = r.required_nozzle_diameter_mm != null ? Number(r.required_nozzle_diameter_mm) : null;
        const mat = r.required_nozzle_material;
        if (dia == null && !mat) continue;
        const key = reqKey(dia, mat);
        const existing = nozzleReq.get(key);
        if (existing) existing.piece_count += 1;
        else
          nozzleReq.set(key, {
            key,
            diameter_mm: dia,
            material: mat,
            label: [dia != null ? `${dia}mm` : null, mat].filter(Boolean).join(" ") || "Any nozzle",
            piece_count: 1,
          });
      }
    }
    // Bed target: requirements come from the bed row itself (single tech,
    // single nozzle spec spanning the whole plate).
    if (bedIds.length > 0) {
      const bedRes = await this.db.query<{
        required_print_technology: string | null;
        required_multicolor_capable: boolean | null;
        required_nozzle_diameter_mm: number | null;
        required_nozzle_material: string | null;
      }>(
        `
          SELECT required_print_technology, required_multicolor_capable,
                 required_nozzle_diameter_mm, required_nozzle_material
          FROM print_beds
          WHERE company_id = $1 AND bed_id = ANY($2::uuid[])
        `,
        [companyId, bedIds]
      );
      for (const r of bedRes.rows) {
        if (r.required_print_technology) techFamilies.add(techFamily(r.required_print_technology));
        if (r.required_multicolor_capable) requireMulticolor = true;
        // Same rule the piece branch above applies, and it was missing here: a
        // resin PLATE has no nozzle either. A bed whose technology was switched
        // to MSLA/SLA still carries its old diameter/material, so testing the
        // columns instead of the technology let a resin bed demand a nozzle no
        // resin machine can offer — and the picker then showed an empty list.
        if (isResinTech(r.required_print_technology)) continue;
        const dia = r.required_nozzle_diameter_mm != null ? Number(r.required_nozzle_diameter_mm) : null;
        const mat = r.required_nozzle_material;
        if (dia == null && !mat) continue;
        const key = reqKey(dia, mat);
        // Accumulates, exactly as the piece branch does. Overwriting was
        // harmless while only one plate could be targeted; with a bulk
        // selection it would report "1" for a spec a dozen plates need, and
        // that count is what tells the operator how much of the batch hangs on
        // each nozzle they are being asked to pick.
        const existingBedReq = nozzleReq.get(key);
        if (existingBedReq) existingBedReq.piece_count += 1;
        else
          nozzleReq.set(key, {
            key,
            diameter_mm: dia,
            material: mat,
            label: [dia != null ? `${dia}mm` : null, mat].filter(Boolean).join(" ") || "Any nozzle",
            piece_count: 1,
          });
      }
      // print_beds has no required_color of its own — unlike the nozzle spec,
      // colour was never duplicated onto the plate — so a resin plate's colour
      // demand is the union of the colours of the parts packed on it. In
      // practice a plate is one colour (it is one pour), but deriving rather
      // than assuming keeps a mixed plate honest: it will match no tank and say
      // so, instead of silently pouring one of the two colours.
      const bedResin = bedRes.rows.some((r) => isResinTech(r.required_print_technology));
      if (bedResin) {
        const bedColors = await this.db.query<{ required_color: string | null }>(
          `SELECT DISTINCT required_color
             FROM order_pieces
            WHERE company_id = $1 AND bed_id = ANY($2::uuid[])
              AND NULLIF(TRIM(required_color), '') IS NOT NULL`,
          [companyId, bedIds]
        );
        for (const r of bedColors.rows) {
          const c = (r.required_color ?? "").trim();
          if (c) resinColorSet.set(c.toLowerCase(), c);
        }
      }
    }
    const resinColorsWanted = Array.from(resinColorSet.values());
    const requirements = Array.from(nozzleReq.values()).sort(
      (a, b) => (a.diameter_mm ?? 0) - (b.diameter_mm ?? 0) || a.label.localeCompare(b.label)
    );
    const requirementKeys = requirements.map((r) => r.key);
    // Does a nozzle satisfy a requirement? Diameter must match when stated;
    // material must match when both state one (a material-less nozzle is a
    // wildcard) — same soft rule the Advanced filter uses.
    const nozzleSatisfies = (
      n: { nozzle_diameter_mm: number | null; nozzle_material: string | null },
      req: { diameter_mm: number | null; material: string | null }
    ): boolean => {
      if (req.diameter_mm != null && Number(n.nozzle_diameter_mm) !== Number(req.diameter_mm)) return false;
      if (req.material && n.nozzle_material && n.nozzle_material.toLowerCase() !== req.material.toLowerCase()) return false;
      return true;
    };
    // The selection spans more than one technology family (e.g. an FDM piece and
    // a resin piece) — no single printer can run them all.
    if (techFamilies.size > 1) {
      return { window_end: windowEnd.toISOString(), is_resin: false, printers: [] };
    }
    const requiredFamily = techFamilies.size === 1 ? [...techFamilies][0] : null;
    // Announced to the picker so it can drop every nozzle affordance rather than
    // render them empty. The picker cannot infer this from `requirements` being
    // empty — a single unconstrained FDM piece also has no requirements, and
    // that one DOES still need a nozzle chosen.
    const isResinTarget = requiredFamily === "RESIN";

    // $1 = company, $2 = window end. Compatibility filters add params after.
    const params: unknown[] = [companyId, windowEnd.toISOString()];
    const filters: string[] = [
      "pi.company_id = $1",
      // Offline / under-maintenance printers are omitted.
      "COALESCE(ps.is_offline, false) = false",
      "COALESCE(ps.is_under_maintenance, false) = false",
    ];
    if (requiredFamily) {
      params.push(requiredFamily);
      filters.push(
        `CASE WHEN COALESCE(pr.print_technology, pi.print_technology) IN ('SLA','MSLA')
              THEN 'RESIN'
              ELSE COALESCE(pr.print_technology, pi.print_technology) END = $${params.length}`
      );
    }
    if (requireMulticolor) {
      filters.push("COALESCE(pr.is_multicolor, pi.is_multicolor) = true");
    }

    const result = await this.db.query<{
      printer_id: string;
      brand: string;
      model: string;
      print_technology: string | null;
      marker: string | null;
      running_until: string | null;
      busy_minutes: string | number;
    }>(
      `
        SELECT
          pi.printer_id,
          pi.brand,
          pi.model,
          -- Identity for the picker's badge. This is the screen where the
          -- operator CHOOSES a machine, so "which physical box is this" and
          -- "what can it run" matter more here than anywhere else.
          pi.print_technology,
          pi.marker,
          MAX(CASE WHEN op.scheduled_start_at <= now() AND op.scheduled_end_at > now()
                   THEN op.scheduled_end_at END) AS running_until,
          COALESCE(SUM(
            EXTRACT(EPOCH FROM (
              LEAST(op.scheduled_end_at, $2::timestamptz) - GREATEST(op.scheduled_start_at, now())
            )) / 60.0
          ) FILTER (
            WHERE op.scheduled_end_at > now() AND op.scheduled_start_at < $2::timestamptz
          ), 0) AS busy_minutes
        FROM printer_instances pi
        INNER JOIN printer_stock ps
          ON ps.printer_id = pi.printer_id
        LEFT JOIN printer_reference pr
          ON pr.printer_ref_id = pi.printer_ref_id
        LEFT JOIN order_pieces op
          ON op.assigned_printer_id = pi.printer_id
          AND op.company_id = pi.company_id
          AND op.status IN ('scheduled', 'printing')
          AND op.scheduled_start_at IS NOT NULL
          AND op.scheduled_end_at IS NOT NULL
        WHERE ${filters.join(" AND ")}
        GROUP BY pi.printer_id, pi.brand, pi.model, pi.print_technology, pi.marker
        ORDER BY pi.brand, pi.model
      `,
      params
    );

    // Beds occupy printers too — fold their scheduled/printing blocks into the
    // same "busy until / busy minutes" figures so a printer running a packed
    // plate doesn't read as free. Merged in JS to keep the piece query simple.
    const bedBusy = new Map<string, { running_until: string | null; busy_minutes: number }>();
    try {
      const bedBusyRes = await this.db.query<{
        printer_id: string;
        running_until: string | null;
        busy_minutes: string | number;
      }>(
        `
          SELECT
            pb.assigned_printer_id AS printer_id,
            MAX(CASE WHEN pb.scheduled_start_at <= now() AND pb.scheduled_end_at > now()
                     THEN pb.scheduled_end_at END) AS running_until,
            COALESCE(SUM(
              EXTRACT(EPOCH FROM (
                LEAST(pb.scheduled_end_at, $2::timestamptz) - GREATEST(pb.scheduled_start_at, now())
              )) / 60.0
            ) FILTER (
              WHERE pb.scheduled_end_at > now() AND pb.scheduled_start_at < $2::timestamptz
            ), 0) AS busy_minutes
          FROM print_beds pb
          WHERE pb.company_id = $1
            AND pb.assigned_printer_id IS NOT NULL
            AND pb.status IN ('scheduled', 'printing')
            AND pb.scheduled_start_at IS NOT NULL
            AND pb.scheduled_end_at IS NOT NULL
          GROUP BY pb.assigned_printer_id
        `,
        [companyId, windowEnd.toISOString()]
      );
      for (const r of bedBusyRes.rows) {
        bedBusy.set(r.printer_id, {
          running_until: r.running_until,
          busy_minutes: Number(r.busy_minutes) || 0,
        });
      }
    } catch { /* print_beds not migrated yet — piece blocks alone are correct */ }

    // Compatible nozzles per printer, so the picker can let the operator choose
    // one explicitly. Ordered smallest-diameter first; available stock first.
    const nozzlesResult = await this.db.query<{
      printer_id: string;
      nozzle_asset_id: string;
      nozzle_diameter_mm: number | null;
      nozzle_material: string | null;
      nozzle_status: string;
    }>(
      `
        SELECT
          pnc.printer_id,
          pnc.nozzle_asset_id,
          ai.nozzle_diameter_mm,
          ai.nozzle_material,
          COALESCE(asto.status, 'available') AS nozzle_status
        FROM printer_nozzle_compatibility pnc
        JOIN asset_instances ai ON ai.asset_id = pnc.nozzle_asset_id
        LEFT JOIN asset_stock asto ON asto.asset_id = pnc.nozzle_asset_id
        WHERE pnc.company_id = $1
        ORDER BY (COALESCE(asto.status, 'available') = 'available') DESC,
                 ai.nozzle_diameter_mm ASC NULLS LAST
      `,
      [companyId]
    );
    type NozzleOut = {
      nozzle_asset_id: string;
      nozzle_diameter_mm: number | null;
      nozzle_material: string | null;
      nozzle_status: string;
      // Requirement keys this nozzle satisfies (empty when there are no nozzle
      // requirements — single un-constrained piece, or none selected).
      satisfies: string[];
    };
    const nozzlesByPrinter = new Map<string, NozzleOut[]>();
    // A resin target gets NO nozzle roster at all — not even a stale one. Some
    // shops have linked nozzle assets to a resin machine by accident, and the
    // picker would then offer hardware that physically cannot be fitted.
    if (!isResinTarget) {
      for (const n of nozzlesResult.rows) {
        const arr = nozzlesByPrinter.get(n.printer_id) ?? [];
        arr.push({
          nozzle_asset_id: n.nozzle_asset_id,
          nozzle_diameter_mm: n.nozzle_diameter_mm,
          nozzle_material: n.nozzle_material,
          nozzle_status: n.nozzle_status,
          satisfies: requirements.filter((req) => nozzleSatisfies(n, req)).map((req) => req.key),
        });
        nozzlesByPrinter.set(n.printer_id, arr);
      }
    }

    // ── Resin's counterpart of the nozzle roster: the tanks this job could be
    //    poured from. Unlike nozzles a tank is not bound to a printer, so this
    //    is one fleet-wide list rather than a per-printer one. Read-only info
    //    for the picker (which tank the one-click assign will use, and how much
    //    is left in it) plus the material for an explicit override.
    type TankOut = {
      tank_asset_id: string;
      label: string | null;
      free_ml: number | null;
      tech_compat: string;
      expiry_date: string | null;
      /** Colour name + optional swatch, so the picker can show what will
       *  actually come off the plate rather than just a bottle name. */
      color: string | null;
      hex: string | null;
    };
    let resinTanks: TankOut[] = [];
    if (isResinTarget) {
      const tanksRes = await this.db.query<{
        asset_id: string; label: string | null; free_ml: string | null;
        tech_compat: string; expiry_date: string | null;
        color: string | null; hex: string | null;
      }>(
        `SELECT ai.asset_id,
                NULLIF(TRIM(CONCAT_WS(' ', ai.resin_brand, ai.resin_type, ai.resin_color)), '') AS label,
                (COALESCE(ast.remaining_volume_ml, 0) - COALESCE(ast.reserved_volume_ml, 0))::text AS free_ml,
                COALESCE(ai.resin_tech_compat, 'both') AS tech_compat,
                ai.resin_expiry_date::text AS expiry_date,
                NULLIF(TRIM(ai.resin_color), '') AS color,
                NULLIF(TRIM(ai.resin_hex), '') AS hex
           FROM asset_instances ai
           LEFT JOIN asset_stock ast ON ast.asset_id = ai.asset_id
          WHERE ai.company_id = $1
            AND ai.asset_type = 'resin_tank'
            AND ai.split_at IS NULL
            AND (ai.resin_expiry_date IS NULL OR ai.resin_expiry_date >= CURRENT_DATE)
          ORDER BY (COALESCE(ast.remaining_volume_ml, 0) - COALESCE(ast.reserved_volume_ml, 0)) DESC`,
        [companyId]
      );
      // Only tanks that can actually produce the requested colour. Showing a
      // yellow tank to a blue print is offering the operator a way to scrap the
      // part — the cure is permanent. When the selection spans several colours,
      // a tank qualifies if it can serve ANY of them (the operator assigns them
      // one at a time from here); an unrecorded colour on either side is a
      // wildcard, so shops that don't track colour see no change at all.
      resinTanks = tanksRes.rows
        .filter((t) =>
          resinColorsWanted.length === 0 ||
          resinColorsWanted.some((want) => colorCompatible(want, t.color))
        )
        .map((t) => ({
          tank_asset_id: t.asset_id,
          label: t.label,
          free_ml: t.free_ml == null ? null : Number(t.free_ml),
          tech_compat: t.tech_compat,
          expiry_date: t.expiry_date,
          color: t.color,
          hex: t.hex,
        }));
    }

    const windowMinutes = (windowEnd.getTime() - now.getTime()) / 60000;
    const printers = result.rows.map((r) => {
      const fromBeds = bedBusy.get(r.printer_id);
      const busy = (Number(r.busy_minutes) || 0) + (fromBeds?.busy_minutes ?? 0);
      // Next idle = when the LAST currently-running block (piece or bed) ends.
      const runningUntil = [r.running_until, fromBeds?.running_until ?? null]
        .filter((v): v is string => !!v)
        .sort()
        .pop() ?? null;
      const nozzles = nozzlesByPrinter.get(r.printer_id) ?? [];
      // Which requirements this printer can satisfy (has ≥1 compatible nozzle),
      // and the subset whose matching nozzle is actually AVAILABLE right now.
      const satisfiedKeys = new Set<string>();
      const availableKeys = new Set<string>();
      for (const n of nozzles) {
        for (const k of n.satisfies) {
          satisfiedKeys.add(k);
          if (n.nozzle_status === "available") availableKeys.add(k);
        }
      }
      return {
        printer_id: r.printer_id,
        brand: r.brand,
        model: r.model,
        print_technology: r.print_technology,
        marker: r.marker,
        // null = idle now; otherwise when the current block (piece or bed) ends.
        next_idle_at: runningUntil,
        free_minutes: Math.max(0, Math.round(windowMinutes - busy)),
        nozzles,
        satisfied_keys: [...satisfiedKeys],
        // Compatible with every needed nozzle; "available" further requires the
        // matching nozzle be in stock. Both feed the picker — covers_all is the
        // soft default surface, available is the gold-star.
        covers_all: requirementKeys.every((k) => satisfiedKeys.has(k)),
        covers_all_available: requirementKeys.every((k) => availableKeys.has(k)),
      };
    });
    // Surface the fullest-coverage printers first (covered+available → covered →
    // partial), preserving the SQL brand/model order within each tier. Soft, not
    // a hard filter — the picker can still reveal partial-coverage printers.
    const tier = (p: { covers_all: boolean; covers_all_available: boolean }) =>
      p.covers_all_available ? 0 : p.covers_all ? 1 : 2;
    printers.sort((a, b) => tier(a) - tier(b));
    return {
      window_end: windowEnd.toISOString(),
      // The picker keys its whole nozzle-vs-tank presentation off this. See the
      // note at isResinTarget for why an empty `requirements` list isn't enough.
      is_resin: isResinTarget,
      requirements,
      // The colours this selection demands. The picker shows them so an empty
      // tank list reads as "no BLACK tank" rather than "no tanks", which is the
      // difference between a 5-second fix and a support ticket.
      resin_colors_wanted: resinColorsWanted,
      resin_tanks: resinTanks,
      printers,
    };
  }

  // ──────────────────────────────────────────────────────────
  // POST /api/simple-jobs/auto-schedule
  // One-click packing: place each ready item at the EARLIEST instant where its
  // printer AND nozzle AND every reserved spool are simultaneously free —
  // back-to-back, never overlapping any timeline. Placement math runs here
  // against one snapshot of all committed blocks; each commit still goes
  // through jobs/beds schedule() so every server guard re-validates it.
  // Pieces with no spool reservation get the auto-planned spool reserved
  // first (same fallback the manual Reserve button uses).
  // ──────────────────────────────────────────────────────────
  /**
   * The company's saved default working hours, or nulls for round the clock.
   *
   * Best-effort like the rest of the company settings: if the migration hasn't
   * run, an auto-schedule must still work — it just isn't hour-constrained.
   */
  private async companyWorkingHours(
    companyId: string,
  ): Promise<{ startHour: number | null; latestStartHour: number | null }> {
    try {
      const r = await this.db.query<{ work_start_hour: number | null; work_latest_start_hour: number | null }>(
        `SELECT work_start_hour, work_latest_start_hour FROM companies WHERE company_id = $1`,
        [companyId]
      );
      const row = r.rows[0];
      return {
        startHour: row?.work_start_hour ?? null,
        latestStartHour: row?.work_latest_start_hour ?? null,
      };
    } catch {
      return { startHour: null, latestStartHour: null };
    }
  }

  /**
   * Everything the fleet-wide packer would act on: ready, unscheduled, and
   * actually assigned to a printer. Deliberately the same gate autoSchedule's
   * loop applies, so the count on the button matches what the plan contains.
   */
  async listSchedulable(companyId: string, printerIds?: string[]) {
    const scoped = printerIds && printerIds.length > 0;
    const params: unknown[] = [companyId];
    if (scoped) params.push(printerIds);
    const pieces = await this.db.query<{
      piece_id: string; piece_name: string; printer_id: string;
      printer_label: string | null; minutes: number | null; deadline: string | null;
    }>(
      `SELECT op.piece_id, op.piece_name, op.assigned_printer_id AS printer_id,
              CASE WHEN pi.printer_id IS NOT NULL THEN pi.brand || ' ' || pi.model ELSE NULL END AS printer_label,
              op.slicer_print_time_minutes AS minutes, o.deadline::text AS deadline
         FROM order_pieces op
         JOIN orders o ON o.order_id = op.order_id
         LEFT JOIN printer_instances pi ON pi.printer_id = op.assigned_printer_id
        WHERE op.company_id = $1 AND op.status = 'ready'
          AND op.assigned_printer_id IS NOT NULL
          AND op.scheduled_start_at IS NULL
          AND op.bed_id IS NULL
          ${scoped ? "AND op.assigned_printer_id = ANY($2::uuid[])" : ""}`,
      params
    );
    type Item = {
      id: string; is_bed: boolean; name: string;
      printer_id: string; printer_label: string | null;
      minutes: number | null; deadline: string | null;
    };
    const items: Item[] = pieces.rows.map((r) => ({
      id: r.piece_id, is_bed: false, name: r.piece_name,
      printer_id: r.printer_id, printer_label: r.printer_label,
      minutes: r.minutes != null ? Number(r.minutes) : null,
      deadline: r.deadline,
    }));
    try {
      const beds = await this.db.query<{
        bed_id: string; bed_name: string; printer_id: string;
        printer_label: string | null; minutes: number | null; deadline: string | null;
      }>(
        `SELECT b.bed_id, b.bed_name, b.assigned_printer_id AS printer_id,
                CASE WHEN pi.printer_id IS NOT NULL THEN pi.brand || ' ' || pi.model ELSE NULL END AS printer_label,
                b.slicer_print_time_minutes AS minutes,
                b.effective_deadline::text AS deadline
           FROM print_beds b
           LEFT JOIN printer_instances pi ON pi.printer_id = b.assigned_printer_id
          WHERE b.company_id = $1 AND b.status = 'ready'
            AND b.assigned_printer_id IS NOT NULL
            AND b.scheduled_start_at IS NULL
            ${scoped ? "AND b.assigned_printer_id = ANY($2::uuid[])" : ""}`,
        params
      );
      for (const r of beds.rows) {
        items.push({
          id: r.bed_id, is_bed: true, name: r.bed_name,
          printer_id: r.printer_id, printer_label: r.printer_label,
          minutes: r.minutes != null ? Number(r.minutes) : null,
          deadline: r.deadline,
        });
      }
    } catch { /* print_beds not migrated yet — pieces alone are correct */ }

    const printers = new Map<string, { printer_id: string; printer_label: string | null; jobs: number }>();
    for (const i of items) {
      const cur = printers.get(i.printer_id) ?? { printer_id: i.printer_id, printer_label: i.printer_label, jobs: 0 };
      cur.jobs += 1;
      printers.set(i.printer_id, cur);
    }
    return { items, printers: Array.from(printers.values()) };
  }

  /**
   * Fleet-wide pack. Gathers the whole schedulable backlog and hands it to the
   * one packer, so all printers are filled in a single least-slack pass.
   *
   * Why this matters beyond convenience: run per-printer and each run only sees
   * its own printer's contention, so two printers that share a nozzle both plan
   * as if they own it and the second commit collides. One pass over the whole
   * fleet resolves shared nozzles and spools globally — which is also what lets
   * nozzle substitution pay off, since it can see that the 0.4mm brass on
   * Printer 2 is idle exactly when Printer 1 wants one.
   */
  async autoScheduleAll(
    companyId: string,
    input: {
      dry_run?: boolean | undefined;
      min_margin_minutes?: number | undefined;
      nozzle_policy?: NozzlePolicy | undefined;
      /** Earliest / latest LOCAL hour a print may be started, plus the caller's
       *  UTC offset so the hours mean the shop's clock, not the server's. */
      work_start_hour?: number | null | undefined;
      work_latest_start_hour?: number | null | undefined;
      tz_offset_minutes?: number | undefined;
      /** @deprecated older spelling of nozzle_policy: "keep_assigned". */
      allow_nozzle_swap?: boolean | undefined;
      printer_ids?: string[] | undefined;
      /** Force the background-run path regardless of size. The review step uses
       *  it so a preview and its commit behave the same way. */
      as_run?: boolean | undefined;
      /** Who started it, for the run's audit row. */
      user_id?: string | undefined;
    }
  ) {
    const { items, printers } = await this.listSchedulable(companyId, input.printer_ids);
    if (items.length === 0) {
      return {
        placed: [], skipped: [], ordered_by: "least_slack_first" as const,
        dry_run: input.dry_run === true,
        min_margin_minutes: input.min_margin_minutes ?? 5,
        nozzle_swaps: 0, span_minutes: 0, utilisation: [],
        window_effect: null,
        printers,
      };
    }

    // ── Big packs run as a BACKGROUND RUN, not as this request ──────────────
    //
    // Committing a placement goes through the guarded schedule(): ten-odd
    // queries of preconditions and conflict checks per item, and that guard is
    // exactly what must not be skipped to make it quicker. Thousands of items
    // is therefore minutes of work, and production reaches this API through an
    // edge proxy that will not hold a request open for it. It also should not:
    // an action that rearranges the whole shop floor deserves a count that
    // moves and a way to stop, and neither is a property a request has.
    //
    // Below the threshold nothing changes — the plan comes back inline, as it
    // always has, which keeps the ordinary handful-of-jobs case a single round
    // trip. And if the batch_runs migration has not been applied, `available()`
    // says so and this falls through to running inline whatever the size: a
    // missing table costs the progress bar, never the feature.
    const wantsRun = input.as_run === true || items.length >= RUN_THRESHOLD_ITEMS;
    if (wantsRun && (await this.runs.available())) {
      const runId = await this.runs.start(
        companyId,
        input.user_id ?? null,
        "auto_schedule",
        { items: items.length, dry_run: input.dry_run === true, printers: printers.length },
        async (ctx) => {
          const planned = await this.autoSchedule(
            companyId,
            {
              items: items.map((i) => ({ id: i.id, is_bed: i.is_bed })),
              ...(input.dry_run !== undefined ? { dry_run: input.dry_run } : {}),
              ...(input.min_margin_minutes !== undefined ? { min_margin_minutes: input.min_margin_minutes } : {}),
              ...(input.nozzle_policy !== undefined ? { nozzle_policy: input.nozzle_policy } : {}),
              ...(input.work_start_hour !== undefined ? { work_start_hour: input.work_start_hour } : {}),
              ...(input.work_latest_start_hour !== undefined ? { work_latest_start_hour: input.work_latest_start_hour } : {}),
              ...(input.tz_offset_minutes !== undefined ? { tz_offset_minutes: input.tz_offset_minutes } : {}),
              ...(input.allow_nozzle_swap !== undefined ? { allow_nozzle_swap: input.allow_nozzle_swap } : {}),
            },
            {
              onTotal: (total) => ctx.setTotal(total),
              onItem: (outcome) => ctx.advance(outcome),
              shouldStop: () => ctx.cancelled(),
            },
          );
          return { ...planned, printers };
        },
      );
      return { run_id: runId, async_run: true as const, total: items.length, printers };
    }

    const result = await this.autoSchedule(companyId, {
      items: items.map((i) => ({ id: i.id, is_bed: i.is_bed })),
      ...(input.dry_run !== undefined ? { dry_run: input.dry_run } : {}),
      ...(input.min_margin_minutes !== undefined ? { min_margin_minutes: input.min_margin_minutes } : {}),
      ...(input.nozzle_policy !== undefined ? { nozzle_policy: input.nozzle_policy } : {}),
      ...(input.work_start_hour !== undefined ? { work_start_hour: input.work_start_hour } : {}),
      ...(input.work_latest_start_hour !== undefined ? { work_latest_start_hour: input.work_latest_start_hour } : {}),
      ...(input.tz_offset_minutes !== undefined ? { tz_offset_minutes: input.tz_offset_minutes } : {}),
      ...(input.allow_nozzle_swap !== undefined ? { allow_nozzle_swap: input.allow_nozzle_swap } : {}),
    });
    // Carry the printer roster through so the review step can label lanes
    // without a second round trip.
    return { ...result, printers };
  }

  async autoSchedule(
    companyId: string,
    input: {
      items: Array<{ id: string; is_bed?: boolean | undefined }>;
      dry_run?: boolean | undefined;
      min_margin_minutes?: number | undefined;
      nozzle_policy?: NozzlePolicy | undefined;
      /** Earliest / latest LOCAL hour a print may be started, plus the caller's
       *  UTC offset so the hours mean the shop's clock, not the server's. */
      work_start_hour?: number | null | undefined;
      work_latest_start_hour?: number | null | undefined;
      tz_offset_minutes?: number | undefined;
      /** @deprecated older spelling of nozzle_policy: "keep_assigned". */
      allow_nozzle_swap?: boolean | undefined;
    },
    /** Optional reporting for a pack running as a background run. Absent for
     *  every synchronous caller, which is why the pack itself does not know
     *  what a run is — it just says how far it has got and asks whether to
     *  stop. See runs.service.ts. */
    hooks?: {
      /** Called once, as soon as the size of the pack is known. */
      onTotal?: (total: number) => Promise<void>;
      /** One candidate resolved. A SKIPPED candidate reports "failed": it did
       *  not do the thing, and the operator counting progress cares about that
       *  distinction more than about why. The reasons are in the result. */
      onItem?: (outcome: "succeeded" | "failed") => Promise<void>;
      /** Asked before each candidate. True stops the pack — see the loop. */
      shouldStop?: () => Promise<boolean>;
    }
  ) {
    // dry_run simulates the whole pack and commits nothing — no schedule(), no
    // reserveSpools(), no nozzle swap. Everything else (ordering, conflict
    // resolution, the 60-day horizon, the margins) runs identically, so the
    // preview and the commit agree unless the board changed in between. Caveat
    // worth being honest about: the guarded schedule() is what rejects an
    // offline printer or a stale status, and dry_run doesn't call it — so the
    // commit can still skip an item the preview showed as placed. The response
    // carries `dry_run` so the client can say that out loud.
    const dryRun = input.dry_run === true;
    const LEAD_MS = 4 * 60_000; // clears schedule()'s past-check + operator lead
    // Turnaround between two blocks on any shared resource. Defaults to the
    // 5 min this has always enforced — physically you must pull the finished
    // print and prep the bed — but the operator can override it per run from the
    // review step, down to 0 for genuinely back-to-back work. Clamped to a day
    // so a fat-fingered value can't silently empty the board.
    const GAP_MS = Math.max(0, Math.min(1440, input.min_margin_minutes ?? 5)) * 60_000;
    // How much freedom the packer has over nozzles (see NozzlePolicy):
    //   earliest         — substitute an equivalent nozzle to open an earlier
    //                      slot. Default, because one busy 0.4mm brass nozzle
    //                      would otherwise stall every job wanting one.
    //   keep_assigned    — never substitute.
    //   minimise_changes — one nozzle per printer per spec for the whole plan,
    //                      for shops that would rather queue than keep swapping
    //                      hardware between prints.
    // `allow_nozzle_swap: false` is the older spelling of keep_assigned; still
    // honoured so a client mid-deploy doesn't silently get substitutions.
    const nozzlePolicy: NozzlePolicy =
      input.nozzle_policy ?? (input.allow_nozzle_swap === false ? "keep_assigned" : "earliest");
    // minimise_changes only: printer+spec → the nozzle that printer is keeping.
    const pinnedNozzleBySpec = new Map<string, string>();
    // Working hours. Constrains when a print may be STARTED — a long print runs
    // on unattended past closing, which is normal. Absent = round the clock.
    //
    // The request wins when it names hours (the review step's per-run
    // override); otherwise the company's saved default applies. `null` from the
    // request is NOT "unset" — the review step sends nulls to mean "ignore our
    // working hours for this run", so an explicit clear must not fall back to
    // the default. That's what the `in` checks distinguish.
    const requestNamesHours =
      "work_start_hour" in input || "work_latest_start_hour" in input;
    let startHour = input.work_start_hour ?? null;
    let latestStartHour = input.work_latest_start_hour ?? null;
    if (!requestNamesHours) {
      const saved = await this.companyWorkingHours(companyId);
      startHour = saved.startHour;
      latestStartHour = saved.latestStartHour;
    }
    // A window covering the whole day is the same as none, so it's dropped
    // rather than carried through every placement as a no-op.
    const workWindow: WorkWindow | null =
      startHour != null && latestStartHour != null && startHour !== latestStartHour
        ? {
            startHour,
            latestStartHour,
            tzOffsetMinutes: input.tz_offset_minutes ?? 0,
          }
        : null;
    const HORIZON_MS = 60 * 24 * 60 * 60_000;
    // How many commits between order-status rollups. Big enough that the
    // rollups are a rounding error next to the commits, small enough that an
    // interrupted run leaves at most this many pieces ahead of their order.
    const ORDER_SYNC_EVERY = 500;
    const now = Date.now();

    const printerBusy = new Map<string, Interval[]>();
    const nozzleBusy = new Map<string, Interval[]>();
    // Filament spools AND resin tanks. Both are material sources that can only
    // feed one print at a time, both are keyed by asset id, and the packer's
    // question of them is identical — "is this thing free in that window?" — so
    // they share one map rather than duplicating the whole fit loop.
    const materialBusy = new Map<string, Interval[]>();
    // Every list is kept ORDERED BY START, because that is what lets the fit
    // below skip sorting. A plain push plus a sort inside the fit is what made
    // a 5,000-item pack take a minute of CPU; see earliestFitAcross.
    const push = (m: Map<string, Interval[]>, k: string | null, iv: Interval) => {
      if (!k) return;
      const arr = m.get(k) ?? [];
      pushInterval(arr, iv);
      m.set(k, arr);
    };
    /** Shared empty list, so a resource with no blocks costs no allocation on
     *  the hot path (three lookups per nozzle option per candidate). */
    const NO_BLOCKS: readonly Interval[] = [];

    // ── Snapshot every committed block (pieces + beds), bucketed per resource.
    const pieceWindow = new Map<string, Interval>();
    const pieceBlocks = await this.db.query<{
      piece_id: string; assigned_printer_id: string | null;
      assigned_nozzle_asset_id: string | null; resin_tank_id: string | null;
      s: string; e: string;
    }>(
      `SELECT piece_id, assigned_printer_id, assigned_nozzle_asset_id, resin_tank_id,
              scheduled_start_at::text AS s, scheduled_end_at::text AS e
         FROM order_pieces
        WHERE company_id = $1 AND status IN ('scheduled','printing')
          AND scheduled_start_at IS NOT NULL AND scheduled_end_at IS NOT NULL`,
      [companyId]
    );
    for (const r of pieceBlocks.rows) {
      const iv = { s: Date.parse(r.s), e: Date.parse(r.e) };
      pieceWindow.set(r.piece_id, iv);
      push(printerBusy, r.assigned_printer_id, iv);
      push(nozzleBusy, r.assigned_nozzle_asset_id, iv);
      // A committed resin job holds its tank for the whole window, same as a
      // spool reservation below.
      push(materialBusy, r.resin_tank_id, iv);
    }
    const bedWindow = new Map<string, Interval>();
    try {
      const bedBlocks = await this.db.query<{
        bed_id: string; assigned_printer_id: string | null;
        assigned_nozzle_asset_id: string | null; s: string; e: string;
      }>(
        `SELECT bed_id, assigned_printer_id, assigned_nozzle_asset_id,
                scheduled_start_at::text AS s, scheduled_end_at::text AS e
           FROM print_beds
          WHERE company_id = $1 AND status IN ('scheduled','printing')
            AND scheduled_start_at IS NOT NULL AND scheduled_end_at IS NOT NULL`,
        [companyId]
      );
      for (const r of bedBlocks.rows) {
        const iv = { s: Date.parse(r.s), e: Date.parse(r.e) };
        bedWindow.set(r.bed_id, iv);
        push(printerBusy, r.assigned_printer_id, iv);
        push(nozzleBusy, r.assigned_nozzle_asset_id, iv);
      }
    } catch { /* print_beds not migrated yet */ }
    // Spool reservations occupy the window of their standalone piece — or of
    // their parent BED (bed reservations anchor on a windowless child piece).
    // The resin arm is the tank column on the piece itself (resin has no join
    // table — a print draws from exactly one tank). Both arms feed the SAME
    // materialBusy map, so "a tank can't be in two vats at once" is enforced by
    // the identical code path that stops one spool feeding two printers.
    const spoolRes = await this.db.query<{ spool_asset_id: string; piece_id: string; bed_id: string | null }>(
      `SELECT ops.spool_asset_id, ops.piece_id, op.bed_id
         FROM order_piece_spools ops
         JOIN order_pieces op ON op.piece_id = ops.piece_id
        WHERE ops.company_id = $1
       UNION
       SELECT op.resin_tank_id AS spool_asset_id, op.piece_id, op.bed_id
         FROM order_pieces op
        WHERE op.company_id = $1 AND op.resin_tank_id IS NOT NULL`,
      [companyId]
    );
    for (const r of spoolRes.rows) {
      const iv = r.bed_id ? bedWindow.get(r.bed_id) : pieceWindow.get(r.piece_id);
      if (iv) push(materialBusy, r.spool_asset_id, iv);
    }

    // ── Load the candidates (order preserved for ties; deadline rules).
    const ids = input.items.filter((i) => !i.is_bed).map((i) => i.id);
    const bedIds = input.items.filter((i) => i.is_bed).map((i) => i.id);
    type Candidate = {
      id: string; is_bed: boolean; name: string; status: string;
      printer_id: string | null; nozzle_id: string | null;
      minutes: number | null; deadline: string | null;
      // The nozzle SPEC the piece needs, which is what makes substitution
      // possible: any nozzle meeting this spec will print it identically.
      req_dia: number | null; req_mat: string | null;
      // A resin job has no nozzle and no spool — it has a tank. Carried per
      // candidate because every nozzle/spool step below has to be skipped for
      // it rather than failed: without this the "missing printer/nozzle/print
      // time" gate dropped EVERY resin job, so auto-schedule silently packed
      // the FDM backlog and left the resin backlog untouched.
      is_resin: boolean;
      /** printer + nozzle spec; filled in just before ordering. */
      setupKey?: string;
    };
    const candidates: Candidate[] = [];
    if (ids.length > 0) {
      const r = await this.db.query<{
        piece_id: string; piece_name: string; status: string;
        assigned_printer_id: string | null; assigned_nozzle_asset_id: string | null;
        slicer_print_time_minutes: number | null; deadline: string | null;
        required_nozzle_diameter_mm: number | null; required_nozzle_material: string | null;
        required_print_technology: string | null;
      }>(
        `SELECT op.piece_id, op.piece_name, op.status, op.assigned_printer_id,
                op.assigned_nozzle_asset_id, op.slicer_print_time_minutes,
                op.required_nozzle_diameter_mm, op.required_nozzle_material,
                op.required_print_technology,
                o.deadline::text AS deadline
           FROM order_pieces op
           JOIN orders o ON o.order_id = op.order_id
          WHERE op.company_id = $1 AND op.piece_id = ANY($2::uuid[])`,
        [companyId, ids]
      );
      for (const p of r.rows) {
        candidates.push({
          id: p.piece_id, is_bed: false, name: p.piece_name, status: p.status,
          printer_id: p.assigned_printer_id, nozzle_id: p.assigned_nozzle_asset_id,
          minutes: p.slicer_print_time_minutes != null ? Number(p.slicer_print_time_minutes) : null,
          deadline: p.deadline,
          req_dia: p.required_nozzle_diameter_mm != null ? Number(p.required_nozzle_diameter_mm) : null,
          req_mat: p.required_nozzle_material,
          is_resin: isResinTech(p.required_print_technology),
        });
      }
    }
    if (bedIds.length > 0) {
      const r = await this.db.query<{
        bed_id: string; bed_name: string; status: string;
        assigned_printer_id: string | null; assigned_nozzle_asset_id: string | null;
        slicer_print_time_minutes: number | null; deadline: string | null;
        required_nozzle_diameter_mm: number | null; required_nozzle_material: string | null;
        required_print_technology: string | null;
      }>(
        `SELECT bed_id, bed_name, status, assigned_printer_id, assigned_nozzle_asset_id,
                slicer_print_time_minutes, required_nozzle_diameter_mm,
                required_nozzle_material, required_print_technology,
                effective_deadline::text AS deadline
           FROM print_beds
          WHERE company_id = $1 AND bed_id = ANY($2::uuid[])`,
        [companyId, bedIds]
      );
      for (const b of r.rows) {
        candidates.push({
          id: b.bed_id, is_bed: true, name: b.bed_name, status: b.status,
          printer_id: b.assigned_printer_id, nozzle_id: b.assigned_nozzle_asset_id,
          minutes: b.slicer_print_time_minutes != null ? Number(b.slicer_print_time_minutes) : null,
          deadline: b.deadline,
          req_dia: b.required_nozzle_diameter_mm != null ? Number(b.required_nozzle_diameter_mm) : null,
          req_mat: b.required_nozzle_material,
          is_resin: isResinTech(b.required_print_technology),
        });
      }
    }

    // ── Nozzle roster for every printer in this batch, in ONE query. A nozzle is
    //    interchangeable with another of the same diameter + material, so this
    //    turns "which nozzle" from a fixed input into a choice the packer makes.
    //    installed_on_asset_id matters: a nozzle sitting on ANOTHER printer can
    //    still be used, but someone has to physically move it, so those are
    //    ranked last and reported in the plan rather than assumed free.
    const nozzlesByPrinter = new Map<string, NozzleOption[]>();
    const printerIds = Array.from(
      new Set(candidates.map((c) => c.printer_id).filter((p): p is string => !!p))
    );
    // keep_assigned never consults the roster, so don't pay for it.
    if (nozzlePolicy !== "keep_assigned" && printerIds.length > 0) {
      const r = await this.db.query<{
        printer_id: string; nozzle_asset_id: string;
        nozzle_diameter_mm: number | null; nozzle_material: string | null;
        status: string; installed_on: string | null;
      }>(
        `SELECT pnc.printer_id, pnc.nozzle_asset_id,
                ai.nozzle_diameter_mm, ai.nozzle_material,
                COALESCE(asto.status, 'available') AS status,
                asto.installed_on_asset_id AS installed_on
           FROM printer_nozzle_compatibility pnc
           JOIN asset_instances ai ON ai.asset_id = pnc.nozzle_asset_id
           LEFT JOIN asset_stock asto ON asto.asset_id = pnc.nozzle_asset_id
          WHERE pnc.company_id = $1 AND pnc.printer_id = ANY($2::uuid[])`,
        [companyId, printerIds]
      );
      for (const n of r.rows) {
        const arr = nozzlesByPrinter.get(n.printer_id) ?? [];
        const dia = n.nozzle_diameter_mm != null ? Number(n.nozzle_diameter_mm) : null;
        arr.push({
          nozzle_asset_id: n.nozzle_asset_id,
          nozzle_diameter_mm: dia,
          nozzle_material: n.nozzle_material,
          status: n.status,
          installed_on: n.installed_on,
          label: [dia != null ? `${dia}mm` : null, n.nozzle_material].filter(Boolean).join(" ")
            || `Nozzle ${n.nozzle_asset_id.slice(0, 6)}`,
        });
        nozzlesByPrinter.set(n.printer_id, arr);
      }
    }
    // LEAST-SLACK-FIRST (minimum-laxity). Slack = how much idle buffer a job
    // has before its deadline if it started as early as possible right now:
    //   slack = deadline − now − print_duration.
    // The job with the LEAST slack is the most at-risk of finishing late, so it
    // claims the earliest free slot first — this beats plain earliest-deadline
    // ordering because it accounts for how LONG each job runs (a 3h job due in
    // 4h is tighter than a 10min job due in 1h). Negative slack = already can't
    // make it even if started now; those sort first so they're placed as early
    // as physically possible. No deadline → +∞ slack (packed last, after every
    // time-critical job). Ties break by earlier deadline, then the queue order.
    const orderIndex = new Map(input.items.map((i, idx) => [i.id, idx]));
    // Tag each candidate with the setup it needs — printer + nozzle spec. Jobs
    // sharing one can run back-to-back without touching a spanner, so the
    // ordering below uses it to stop identical work alternating 0.4 / 0.5 /
    // 0.4 / 0.5 purely because that was the queue order.
    for (const c of candidates) {
      c.setupKey = c.printer_id ? nozzleSpecKey(c.printer_id, c.req_dia, c.req_mat) : "";
    }
    candidates.sort((a, b) => compareBySlack(a, b, now, orderIndex));
    // minimise_changes goes further: whole setup RUNS per printer, most urgent
    // run first. That can delay a job behind a more urgent group, which plain
    // least-slack would not — the trade this policy exists to make.
    const ordered = nozzlePolicy === "minimise_changes"
      ? orderForFewestSetups(candidates, now, orderIndex)
      : candidates;

    // ── Reserved spools for every candidate, in ONE round trip per kind. This
    //    used to be a query per candidate inside the loop (up to 200 sequential
    //    awaits); with the preview flow the pack now runs twice per click, so
    //    the loop's round trips were about to double. Batched here instead.
    const reservedByPiece = new Map<string, string[]>();
    if (ids.length > 0) {
      // UNION so a resin piece's tank lands in the same per-piece material list
      // as a filament piece's spools — the fit loop then treats them alike.
      const r = await this.db.query<{ piece_id: string; spool_asset_id: string }>(
        `SELECT piece_id, spool_asset_id FROM order_piece_spools
          WHERE company_id = $1 AND piece_id = ANY($2::uuid[])
         UNION
         SELECT piece_id, resin_tank_id AS spool_asset_id FROM order_pieces
          WHERE company_id = $1 AND piece_id = ANY($2::uuid[])
            AND resin_tank_id IS NOT NULL`,
        [companyId, ids]
      );
      for (const row of r.rows) {
        const arr = reservedByPiece.get(row.piece_id) ?? [];
        arr.push(row.spool_asset_id);
        reservedByPiece.set(row.piece_id, arr);
      }
    }
    const reservedByBed = new Map<string, string[]>();
    if (bedIds.length > 0) {
      // Same UNION as the per-piece query above, for the same reason: a resin
      // plate's material commitment is the TANK on its constituent pieces, not
      // a row in order_piece_spools. Without the second arm a resin bed booked
      // zero material time, so the packer would happily start a second resin
      // job on the very tank this plate is pouring from.
      const r = await this.db.query<{ bed_id: string; spool_asset_id: string }>(
        `SELECT DISTINCT op.bed_id, ops.spool_asset_id
           FROM order_piece_spools ops
           JOIN order_pieces op ON op.piece_id = ops.piece_id
          WHERE ops.company_id = $1 AND op.bed_id = ANY($2::uuid[])
         UNION
         SELECT DISTINCT op.bed_id, op.resin_tank_id AS spool_asset_id
           FROM order_pieces op
          WHERE op.company_id = $1 AND op.bed_id = ANY($2::uuid[])
            AND op.resin_tank_id IS NOT NULL`,
        [companyId, bedIds]
      );
      for (const row of r.rows) {
        const arr = reservedByBed.get(row.bed_id) ?? [];
        arr.push(row.spool_asset_id);
        reservedByBed.set(row.bed_id, arr);
      }
    }

    // `slack_minutes` = the pre-scheduling buffer (drives the order); `late` =
    // the placement actually finishes after the deadline; `deadline_at` echoes
    // the deadline so the UI can explain either. `will_reserve_spool` only
    // appears in a dry run — it marks a piece the commit would auto-reserve
    // stock for, which is a side effect worth showing before it happens.
    const placed: Array<{
      id: string; is_bed: boolean; name: string; start_at: string; end_at: string;
      deadline_at: string | null; slack_minutes: number | null; late: boolean;
      printer_id: string | null; minutes: number | null; will_reserve_spool?: boolean;
      nozzle_asset_id: string | null;
      /** Diameter+material the machine must be wearing. Drives the change count. */
      nozzle_spec: string;
      // Present only when the packer picked a different nozzle than the one
      // assigned — the operator needs to know a swap is part of this plan.
      nozzle_swapped?: true;
      nozzle_label?: string | null;
      nozzle_move_from_printer_id?: string | null;
    }> = [];
    const skipped: Array<{ id: string; is_bed: boolean; name: string; reason: string }> = [];
    /** Orders whose pieces this run committed. Their derived status is settled
     *  once each — see the scheduleCommit call below. */
    const touchedOrders = new Set<string>();
    let committedSinceSync = 0;

    // Progress is reported from the two result arrays rather than from a
    // counter threaded through the loop: every exit path below pushes to
    // exactly one of them, and there are a dozen such paths. Reading the
    // lengths cannot drift out of step with the result the operator is shown.
    let reportedPlaced = 0;
    let reportedSkipped = 0;
    const reportProgress = async () => {
      if (!hooks?.onItem) return;
      while (reportedPlaced < placed.length) { reportedPlaced += 1; await hooks.onItem("succeeded"); }
      while (reportedSkipped < skipped.length) { reportedSkipped += 1; await hooks.onItem("failed"); }
    };
    await hooks?.onTotal?.(ordered.length);
    /** Set once a cancel is seen, so the remaining candidates are reported as
     *  stopped instead of silently vanishing from the plan. */
    let stopped = false;

    for (const c of ordered) {
      await reportProgress();
      // Cancelling STOPS the pack; it never unwinds it. Everything already
      // committed stays committed — so the honest thing is to name every
      // candidate that will not now be attempted, rather than break out and
      // return a plan that is quietly short.
      if (!stopped && hooks?.shouldStop && (await hooks.shouldStop())) stopped = true;
      if (stopped) {
        skipped.push({
          id: c.id, is_bed: c.is_bed, name: c.name,
          reason: "the run was stopped before this one was reached",
        });
        continue;
      }
      if (c.status !== "ready") {
        skipped.push({
          id: c.id, is_bed: c.is_bed, name: c.name,
          reason: c.status === "scheduled" || c.status === "printing"
            ? "already on the board"
            // Name the hardware this job actually needs. Telling a resin
            // operator their piece "needs a nozzle" sends them looking for a
            // part their printer does not have.
            : `not ready yet ('${c.status}' — needs printer, ${c.is_resin ? "resin tank" : "nozzle"} and print data)`,
        });
        continue;
      }
      // A bed is a piece as far as scheduling is concerned: it occupies one
      // printer, mounts one nozzle and draws from real spools, so it clears the
      // same gate. It used to be waved through without a nozzle, which meant a
      // bed booked no nozzle time and could be double-booked against a piece
      // using the very same nozzle.
      // A resin machine has no nozzle at all, so the nozzle half of this gate
      // must be asked only of the technologies that HAVE one. Asked
      // unconditionally it rejected every resin job here — before any placement
      // ran — which is why auto-schedule appeared to work while quietly leaving
      // the entire resin backlog unplaced. Resin's own required resource (the
      // tank) is enforced by schedule() and by the material timeline below.
      if (!c.printer_id || c.minutes == null || c.minutes <= 0 || (!c.is_resin && !c.nozzle_id)) {
        skipped.push({
          id: c.id, is_bed: c.is_bed, name: c.name,
          reason: c.is_resin ? "missing printer/print time" : "missing printer/nozzle/print time",
        });
        continue;
      }

      // Ensure a physical spool is reserved: auto-plan when absent — the same
      // auto-reservation Save uses, so one click is truly enough. Beds go
      // through the identical path; theirs is anchored on the bed's first child
      // piece inside bedsService, which is a storage detail, not a scheduling
      // one. Previously beds only ever read ALREADY-reserved spools, so an
      // unreserved bed booked zero spool time and the packer would happily put
      // a piece on the same spool at the same instant.
      let mySpools: string[] = [];
      let willReserveSpool = false;
      const readReservedSpools = async (): Promise<string[]> => {
        if (c.is_bed) {
          const r = await this.db.query<{ spool_asset_id: string }>(
            `SELECT DISTINCT ops.spool_asset_id
               FROM order_piece_spools ops
               JOIN order_pieces op ON op.piece_id = ops.piece_id
              WHERE ops.company_id = $1 AND op.bed_id = $2
             UNION
             SELECT DISTINCT op.resin_tank_id
               FROM order_pieces op
              WHERE op.company_id = $1 AND op.bed_id = $2
                AND op.resin_tank_id IS NOT NULL`,
            [companyId, c.id]
          );
          return r.rows.map((x) => x.spool_asset_id);
        }
        const r = await this.db.query<{ spool_asset_id: string }>(
          `SELECT spool_asset_id FROM order_piece_spools WHERE company_id = $1 AND piece_id = $2
           UNION
           SELECT resin_tank_id FROM order_pieces
            WHERE company_id = $1 AND piece_id = $2 AND resin_tank_id IS NOT NULL`,
          [companyId, c.id]
        );
        return r.rows.map((x) => x.spool_asset_id);
      };
      mySpools = (c.is_bed ? reservedByBed.get(c.id) : reservedByPiece.get(c.id)) ?? [];
      if (mySpools.length === 0 && c.is_resin) {
        // Resin has no auto-planner to fall back on, and that is deliberate: a
        // spool is chosen from stock by material family, but a tank is POURED
        // INTO THE MACHINE by hand. The operator picks it; we never guess.
        // Sending resin down the filament planner below produced the nonsense
        // "no spool in stock covers this piece's filament" on a job that has no
        // filament — say the true thing instead.
        skipped.push({
          id: c.id, is_bed: c.is_bed, name: c.name,
          reason: `link a resin tank to this ${c.is_bed ? "bed" : "piece"} before scheduling`,
        });
        continue;
      }
      if (mySpools.length === 0) {
        const what = c.is_bed ? "bed" : "piece";
        if (dryRun) {
          // Don't reserve — ask the planner which spool(s) the commit WOULD
          // take, so the simulated placement still honours spool exclusivity
          // instead of ignoring a constraint the real run enforces.
          willReserveSpool = true;
          try {
            // A resin plate's planner returns null (it pours from a tank, which
            // is never auto-planned). Unreachable here — the resin arm above
            // already `continue`d — but narrowed rather than asserted, so the
            // day someone reorders these branches it fails loudly instead of
            // dereferencing null in the packer.
            const plan = c.is_bed
              ? await this.bedsService.filamentPlan(companyId, c.id)
              : await this.jobsService.filamentPlan(companyId, c.id);
            mySpools = !plan
              ? []
              : plan.multicolor
                ? plan.slots.flatMap((s) => s.allocation.map((a) => a.spool_asset_id))
                : plan.allocation.map((a) => a.spool_asset_id);
            if (mySpools.length === 0) {
              skipped.push({
                id: c.id, is_bed: c.is_bed, name: c.name,
                reason: `no spool in stock covers this ${what}'s filament`,
              });
              continue;
            }
          } catch (e) {
            skipped.push({
              id: c.id, is_bed: c.is_bed, name: c.name,
              reason: e instanceof Error ? e.message : "couldn't plan a spool",
            });
            continue;
          }
        } else {
          try {
            if (c.is_bed) await this.bedsService.reserveSpools(companyId, c.id, {});
            else await this.jobsService.reserveSpools(companyId, c.id, {});
            mySpools = await readReservedSpools();
          } catch (e) {
            skipped.push({
              id: c.id, is_bed: c.is_bed, name: c.name,
              reason: e instanceof Error ? e.message : "couldn't reserve a spool",
            });
            continue;
          }
        }
      }

      // ── Earliest instant where printer ∧ nozzle ∧ every spool are free.
      //    First-fit forward scan: start at the lead time and jump past any block
      //    that overlaps (padded by the margin on both sides), repeating until a
      //    full pass moves nothing. Because it only ever jumps to the END of a
      //    conflict, it settles into the first gap wide enough to hold the job —
      //    so short jobs backfill holes instead of queueing at the tail, which is
      //    where most of the utilisation comes from.
      const durMs = Math.max(1, c.minutes) * 60_000;
      // The timelines this job has to clear, as SEPARATE ordered lists. They
      // used to be spread into one combined array on every call — an allocation
      // and a copy of every interval, once per nozzle option per candidate, so
      // thirty thousand copies of a growing array in a 10,000-item pack.
      // earliestFitAcross walks them with cursors instead and copies nothing.
      const printerIvs = printerBusy.get(c.printer_id) ?? NO_BLOCKS;
      const materialLists = mySpools.map((sid) => materialBusy.get(sid) ?? NO_BLOCKS);
      const earliestWith = (nozzleId: string | null): number =>
        earliestFitAcross(
          [printerIvs, nozzleId ? nozzleBusy.get(nozzleId) ?? NO_BLOCKS : NO_BLOCKS, ...materialLists],
          durMs,
          now + LEAD_MS,
          GAP_MS,
          workWindow,
        );

      // ── Nozzle substitution. The assigned nozzle is one option, not the only
      //    one: any nozzle on this printer meeting the piece's spec prints it
      //    identically, so the packer takes whichever opens the earliest slot.
      //    'damaged' is the only status that rules a nozzle out — 'installed'
      //    and 'in_use' are the common, perfectly usable cases.
      const options = (nozzlesByPrinter.get(c.printer_id) ?? []).filter(
        (n) => nozzleFits(n, c.req_dia, c.req_mat) && n.status !== UNUSABLE_NOZZLE_STATUS
      );
      // Under minimise_changes a printer keeps one nozzle per spec for the whole
      // plan, so the first job to need a spec picks it and every later job on
      // that printer needing the same spec inherits it.
      const specKey = nozzleSpecKey(c.printer_id, c.req_dia, c.req_mat);
      const nozzleChoice = chooseNozzle({
        assignedId: c.nozzle_id,
        printerId: c.printer_id,
        options,
        earliestFor: earliestWith,
        policy: nozzlePolicy,
        pinnedId: pinnedNozzleBySpec.get(specKey) ?? null,
      });
      if (nozzlePolicy === "minimise_changes" && nozzleChoice.id) {
        pinnedNozzleBySpec.set(specKey, nozzleChoice.id);
      }
      // Not const: scheduleCommit gets the final word. If the board moved under
      // the plan between choosing and committing, it substitutes an identical
      // free nozzle rather than failing the placement — and the busy maps below
      // must then book the nozzle that was ACTUALLY taken, or the rest of the
      // batch packs around hardware nobody is using.
      let chosenNozzle = nozzleChoice.id;
      const startMs = nozzleChoice.startMs;
      let nozzleMovedFrom = nozzleChoice.movedFromPrinterId;
      let chosenLabel = nozzleChoice.label;
      let nozzleSwapped = nozzleChoice.swapped;

      if (startMs + durMs > now + HORIZON_MS) {
        skipped.push({ id: c.id, is_bed: c.is_bed, name: c.name, reason: "no free slot within 60 days" });
        continue;
      }

      // Commit through the guarded schedule() — never around it. A dry run
      // stops here: the placement is still recorded in the local busy maps
      // below, so the rest of the batch packs around it exactly as it would.
      const startIso = new Date(startMs).toISOString();
      if (!dryRun) {
        // Persist the nozzle swap BEFORE scheduling, while the item is still
        // 'ready' and setNozzle() will take it freely. setNozzle re-validates
        // compatibility itself, so a roster that went stale mid-batch is caught
        // here rather than writing a nozzle the printer can't mount.
        if (nozzleSwapped && chosenNozzle) {
          try {
            if (c.is_bed) await this.bedsService.setNozzle(companyId, c.id, chosenNozzle);
            else await this.jobsService.setNozzle(companyId, c.id, chosenNozzle);
          } catch (e) {
            skipped.push({
              id: c.id, is_bed: c.is_bed, name: c.name,
              reason: e instanceof Error ? `couldn't switch nozzle — ${e.message}` : "couldn't switch nozzle",
            });
            continue;
          }
        }
        // Either commit may substitute an identical nozzle for one that turned
        // out to be busy, and the busy maps below MUST book the nozzle actually
        // taken — book the one we asked for and the rest of the batch packs
        // around hardware nobody is using, and can double-book the substitute.
        // Beds and pieces both, or a plate silently poisons the plan.
        const adoptSwitch = (sw: NozzleSwitch | null | undefined) => {
          if (!sw) return;
          chosenNozzle = sw.to_nozzle_asset_id;
          chosenLabel = sw.to_label;
          nozzleMovedFrom = sw.moved_from_printer_id;
          nozzleSwapped = true;
        };
        try {
          if (c.is_bed) {
            const bed = await this.bedsService.schedule(companyId, c.id, { start_at: startIso });
            adoptSwitch(bed.nozzle_switch);
          } else {
            // scheduleCommit, not schedule: same guards, same write, but it
            // leaves the parent order's status to us. Rolling an order up costs
            // an aggregate over EVERY piece in it, so doing it per piece makes
            // packing one big order O(N²) — the same shape the bulk piece
            // create fixed. Collected here, settled once each after the loop.
            const { order_id, nozzle_switch } = await this.jobsService.scheduleCommit(companyId, c.id, { start_at: startIso });
            adoptSwitch(nozzle_switch);
            touchedOrders.add(order_id);
            committedSinceSync += 1;
            // Settle periodically as well as at the end. Deferring the rollup
            // entirely would mean an interrupted run — a cancel, a restart —
            // left every touched order showing a status its pieces had already
            // moved past. Draining here bounds that window to one batch while
            // still costing a couple of rollups per order instead of one per
            // piece.
            if (committedSinceSync >= ORDER_SYNC_EVERY) {
              committedSinceSync = 0;
              for (const orderId of touchedOrders) {
                await this.jobsService.syncOrderStatusOnce(companyId, orderId);
              }
              touchedOrders.clear();
            }
          }
        } catch (e) {
          skipped.push({
            id: c.id, is_bed: c.is_bed, name: c.name,
            reason: e instanceof Error ? e.message : "schedule was rejected",
          });
          continue;
        }
      }
      const iv = { s: startMs, e: startMs + durMs };
      push(printerBusy, c.printer_id, iv);
      // Book the nozzle we actually chose, not the one that was assigned —
      // otherwise the next candidate would think the substitute is still free.
      push(nozzleBusy, chosenNozzle, iv);
      for (const sid of mySpools) push(materialBusy, sid, iv);
      const dlMs = c.deadline ? Date.parse(c.deadline) : NaN;
      const hasDl = !Number.isNaN(dlMs);
      placed.push({
        id: c.id, is_bed: c.is_bed, name: c.name,
        start_at: startIso, end_at: new Date(startMs + durMs).toISOString(),
        deadline_at: c.deadline ?? null,
        slack_minutes: hasDl ? Math.round((dlMs - now - durMs) / 60_000) : null,
        late: hasDl && startMs + durMs > dlMs,
        printer_id: c.printer_id,
        minutes: c.minutes,
        nozzle_asset_id: chosenNozzle,
        // The SPEC the printer must be wearing for this job. Two different
        // 0.4mm nozzles are interchangeable at the machine — what costs the
        // operator a physical replacement is the spec changing, so the change
        // count below keys on this rather than on the asset id.
        nozzle_spec: nozzleSpecOf(c.req_dia, c.req_mat),
        ...(nozzleSwapped ? {
          nozzle_swapped: true as const,
          nozzle_label: chosenLabel,
          // Set only when the substitute currently sits on a DIFFERENT printer,
          // i.e. the operator has to physically carry it over before this start.
          nozzle_move_from_printer_id: nozzleMovedFrom,
        } : {}),
        ...(dryRun ? { will_reserve_spool: willReserveSpool } : {}),
      });
    }

    await reportProgress();

    // Settle every order this run touched, once each. Deliberately AFTER the
    // whole loop and outside it: an order's status is a function of its final
    // piece set, so the intermediate answers nobody read were pure cost. Errors
    // are swallowed inside syncOrderStatus already — a derived status must
    // never undo a commit that succeeded.
    for (const orderId of touchedOrders) {
      await this.jobsService.syncOrderStatusOnce(companyId, orderId);
    }

    // ── Per-printer utilisation of the plan. "Maximum machine utilisation" is
    //    the objective, so the plan has to be able to show whether it hit it:
    //    busy = the minutes this plan books on the machine, span = wall-clock
    //    from the first start to the last end across the whole plan. A printer
    //    that packs 8h of work into an 8h span is saturated; one that spreads
    //    2h across 30h is where the operator should look.
    let planFrom = Infinity;
    let planTo = -Infinity;
    for (const p of placed) {
      planFrom = Math.min(planFrom, Date.parse(p.start_at));
      planTo = Math.max(planTo, Date.parse(p.end_at));
    }
    const spanMinutes = placed.length > 0 ? Math.round((planTo - planFrom) / 60_000) : 0;
    // ── What the working-hours window did to this plan.
    //
    //    Without this the plan is silent about its own biggest shape. A shop on
    //    08:00–18:00 that packs every staffed hour of three days still reports
    //    ~40% utilisation, because the span it is divided by counts two closed
    //    nights against it — and a pack started after closing opens with a
    //    sixteen-hour hole that looks exactly like the packer refusing to work.
    //    Both are the window behaving correctly (it gates the START instant, so
    //    somebody is there to load the plate), and neither was stated anywhere.
    //
    //    `deferred` is the honest headline: the shop is shut NOW, so nothing
    //    could have started for this long whatever the backlog. It is derived
    //    from the window alone rather than from where the first job landed, so
    //    it still reads correctly when the first job was pushed later by a
    //    conflict instead.
    const earliestAllowed = nextAllowedStart(now + LEAD_MS, workWindow);
    const openMinutes = placed.length > 0
      ? Math.round(openMsBetween(planFrom, planTo, workWindow) / 60_000)
      : 0;
    const windowEffect = workWindow
      ? {
          open_minutes: openMinutes,
          closed_minutes: Math.max(0, spanMinutes - openMinutes),
          first_start_deferred_minutes: Math.round((earliestAllowed - (now + LEAD_MS)) / 60_000),
        }
      : null;
    const perPrinter = new Map<string, { booked_minutes: number; jobs: number }>();
    for (const p of placed) {
      if (!p.printer_id) continue;
      const cur = perPrinter.get(p.printer_id) ?? { booked_minutes: 0, jobs: 0 };
      cur.booked_minutes += Math.round((Date.parse(p.end_at) - Date.parse(p.start_at)) / 60_000);
      cur.jobs += 1;
      perPrinter.set(p.printer_id, cur);
    }
    // ── Physical nozzle replacements the plan implies.
    //
    //    Counted on the SPEC, not the asset id. A printer wears one nozzle at a
    //    time; if the next job on it needs the same 0.4mm brass, the operator
    //    runs it on whatever 0.4mm brass is already fitted and never touches a
    //    spanner — even where the plan names a different nozzle asset, which is
    //    a booking detail (asset-level exclusivity is what keeps two PRINTERS
    //    off the same physical nozzle). A replacement is 0.4 → 0.5, or brass →
    //    hardened: the spec changing between consecutive prints on one machine.
    //
    //    This previously counted asset transitions and so reported swaps the
    //    shop floor would never perform.
    const changesByPrinter = new Map<string, number>();
    const byPrinterSorted = new Map<string, typeof placed>();
    for (const p of placed) {
      if (!p.printer_id) continue;
      const arr = byPrinterSorted.get(p.printer_id) ?? [];
      arr.push(p);
      byPrinterSorted.set(p.printer_id, arr);
    }
    for (const [printerId, arr] of byPrinterSorted) {
      arr.sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
      let changes = 0;
      for (let i = 1; i < arr.length; i++) {
        if (arr[i]!.nozzle_spec !== arr[i - 1]!.nozzle_spec) changes += 1;
      }
      changesByPrinter.set(printerId, changes);
    }

    const utilisation = Array.from(perPrinter.entries())
      .map(([printer_id, v]) => ({
        printer_id,
        booked_minutes: v.booked_minutes,
        jobs: v.jobs,
        // Share of the plan's wall-clock window this machine is actually running.
        // Null when the plan is a single instant (nothing to be a fraction of).
        utilisation_pct: spanMinutes > 0 ? Math.round((v.booked_minutes / spanMinutes) * 100) : null,
        // The same booking measured against the hours a print could actually be
        // STARTED in. Kept beside utilisation_pct rather than replacing it
        // because they answer different questions and a shop needs both: the
        // first is "was the machine running", the second is "did we fill the
        // shift". Null without a window, where the two would be identical.
        //
        // It can exceed 100, and that is a real answer rather than a bug: a
        // print started before closing runs on unattended, so a machine can be
        // busy for more hours than the shop is open. Presenting it capped would
        // hide exactly the overnight running the window is designed to allow.
        utilisation_open_pct: windowEffect && windowEffect.open_minutes > 0
          ? Math.round((v.booked_minutes / windowEffect.open_minutes) * 100)
          : null,
        nozzle_changes: changesByPrinter.get(printer_id) ?? 0,
      }))
      .sort((a, b) => b.booked_minutes - a.booked_minutes);

    // Surface the packing order actually used (least slack first) so the client
    // can show why each job landed where it did — and how many will still miss
    // their deadline even after optimal packing.
    return {
      placed,
      skipped,
      ordered_by: "least_slack_first" as const,
      dry_run: dryRun,
      // Echo the knobs the plan was computed with, so the review step can show
      // what it's reviewing and re-run with a different margin.
      min_margin_minutes: Math.round(GAP_MS / 60_000),
      nozzle_policy: nozzlePolicy,
      work_window: workWindow
        ? { start_hour: workWindow.startHour, latest_start_hour: workWindow.latestStartHour }
        : null,
      nozzle_swaps: placed.filter((p) => p.nozzle_swapped).length,
      // Total physical swaps across the fleet — the number the operator feels.
      nozzle_changes: Array.from(changesByPrinter.values()).reduce((a, b) => a + b, 0),
      span_minutes: spanMinutes,
      // What the working hours cost this plan, so the review step can say it
      // instead of leaving the operator to read a hole in the board as a fault.
      // Null when the shop runs round the clock and there is nothing to explain.
      window_effect: windowEffect,
      utilisation,
    };
  }
}
