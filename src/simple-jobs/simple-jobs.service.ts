import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { JobsService, isResinTech } from "../jobs/jobs.service";
import { BedsService } from "../beds/beds.service";
import { FinanceService } from "../finance/finance.service";
import {
  propagateSlicerMetaToDuplicatesTx,
  quoteAssumedMeta,
  recomputeOrderStatusTx,
  releasePrinterForPieceTx,
} from "../common/cascade";
// The scheduling kernel — pure, unit-tested placement math (see packing.ts and
// test/packing.test.ts). autoSchedule keeps the I/O and calls in here to decide.
import {
  earliestFit,
  earliestFitWithin,
  chooseNozzle,
  nozzleFits,
  nozzleSpecKey,
  nozzleSpecOf,
  orderForFewestSetups,
  compareBySlack,
  UNUSABLE_NOZZLE_STATUS,
  type Interval,
  type NozzleOption,
  type NozzlePolicy,
  type WorkWindow,
} from "./packing";

// Simple mode treats both resin technologies as one family — assigning an SLA
// part to an MSLA printer (or vice-versa) is fine; only cross-family is
// physically impossible and gets blocked.
function techFamily(tech: string): string {
  const t = tech.trim().toUpperCase();
  if (t === "SLA" || t === "MSLA") return "RESIN";
  return t; // FDM, SLS, …
}

@Injectable()
export class SimpleJobsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly jobsService: JobsService,
    private readonly bedsService: BedsService,
    private readonly finance: FinanceService
  ) {}

  // Pieces for orders that live in the company's CURRENT mode — so Simple only
  // ever sees Simple work (and vice-versa), reversibly. Shape matches the
  // JobRow the Advanced queue returns, so the grid is interchangeable.
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
          AND o.operation_mode = (SELECT operation_mode FROM companies WHERE company_id = $1)
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
    nozzleIds?: string[]
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
          await this.db.query<{ asset_id: string; free_ml: string | null }>(
            `
              SELECT ai.asset_id,
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
    /** The emptiest tank that still covers `needMl` (any tank when the volume
     *  isn't known yet — the operator fills it in at the slicer step). */
    const resolveTankFor = (needMl: number | null): string | null => {
      if (resinTanks.length === 0) return null;
      if (needMl == null || !(needMl > 0)) return resinTanks[resinTanks.length - 1]?.asset_id ?? null;
      const fits = resinTanks.find((t) => Number(t.free_ml ?? 0) >= needMl);
      // Nothing covers it: leave it unlinked rather than pick a tank that will
      // fail the volume check at schedule time with a confusing error.
      return fits?.asset_id ?? null;
    };

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
      status: string;
      requires_multicolor: boolean | null;
      cost_inputs: { grams?: string[]; time?: string; failure?: string } | null;
    }>(
      `
        SELECT piece_id, piece_name, required_print_technology,
               required_nozzle_diameter_mm, required_nozzle_material, status,
               requires_multicolor, cost_inputs
        FROM order_pieces
        WHERE company_id = $1
          AND piece_id = ANY($2::uuid[])
      `,
      [companyId, pieceIds]
    );

    const skipped: { piece_id: string; piece_name: string; reason: string }[] = [];
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
      const tank = pieceIsResin ? resolveTankFor(assumed.grams) : null;
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

    // One UPDATE per (nozzle, seed) group. Mark the pieces 'assigned' — or
    // straight to 'ready' when the quote supplied both numbers — and stamp the
    // per-piece nozzle so the schedule wizard has everything it needs. COALESCE
    // keeps any nozzle already on the piece when none could be resolved
    // (printer has no nozzle). The slicer FILE is still cleared: a fresh
    // assignment must never resurrect a previous session's g-code.
    for (const g of groups.values()) {
      if (g.ids.length === 0) continue;
      await this.db.query(
        `
          UPDATE order_pieces
          SET assigned_printer_id = $3,
              assigned_nozzle_asset_id = COALESCE($4::uuid, assigned_nozzle_asset_id),
              resin_tank_id              = COALESCE($7::uuid, resin_tank_id),
              slicer_file_url            = NULL,
              slicer_file_uploaded_at    = NULL,
              slicer_print_time_minutes  = $5,
              slicer_filament_used_grams = $6,
              slicer_resin_used_ml       = $8,
              status = CASE
                -- Each technology's own prerequisites, matching
                -- chk_ready_requires_core_data exactly. Resin has no nozzle, so
                -- the old nozzle-only test left every resin piece at its previous
                -- status while stamping the printer — assigned in the UI, pending
                -- in the database.
                WHEN required_print_technology IN ('MSLA', 'SLA') THEN
                  CASE
                    WHEN $5::int IS NOT NULL AND $8::numeric IS NOT NULL
                     AND COALESCE($7::uuid, resin_tank_id) IS NOT NULL THEN 'ready'
                    ELSE 'assigned'
                  END
                -- 'ready' needs (printer, nozzle, time, grams); 'assigned' needs
                -- printer + nozzle. If no nozzle could be resolved, leave the
                -- status as-is rather than risk an inconsistent 'assigned'.
                WHEN COALESCE($4::uuid, assigned_nozzle_asset_id) IS NOT NULL
                 AND $5::int IS NOT NULL AND $6::numeric IS NOT NULL THEN 'ready'
                WHEN COALESCE($4::uuid, assigned_nozzle_asset_id) IS NOT NULL THEN 'assigned'
                ELSE status
              END
          WHERE company_id = $1
            AND piece_id = ANY($2::uuid[])
        `,
        [companyId, g.ids, printerId, g.nozzle, g.minutes, g.grams, g.tank, g.ml]
      );
    }

    // Multicolor: mirror the quote's per-slot grams into the color slots (only
    // where still unset, and only when the quote has one figure per slot) so
    // the spool planner sees the same assumed demand.
    for (const seed of slotSeeds) {
      const slotCount = await this.db.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM order_piece_color_slots WHERE company_id = $1 AND piece_id = $2`,
        [companyId, seed.piece_id]
      );
      if (Number(slotCount.rows[0]?.n) !== seed.grams.length) continue;
      for (let i = 0; i < seed.grams.length; i++) {
        await this.db.query(
          `UPDATE order_piece_color_slots cs
              SET slicer_grams = $3
             FROM (
               SELECT color_slot_id, ROW_NUMBER() OVER (ORDER BY sequence_order) AS rn
                 FROM order_piece_color_slots
                WHERE company_id = $1 AND piece_id = $2
             ) ordered
            WHERE cs.color_slot_id = ordered.color_slot_id
              AND ordered.rn = $4
              AND cs.slicer_grams IS NULL`,
          [companyId, seed.piece_id, seed.grams[i], i + 1]
        );
      }
    }

    // The picker chains straight into scheduling for pieces that are already
    // 'ready' (quote-seeded) — report which ones those are.
    const readyRes = await this.db.query<{ piece_id: string }>(
      `SELECT piece_id FROM order_pieces
        WHERE company_id = $1 AND piece_id = ANY($2::uuid[]) AND status = 'ready'`,
      [companyId, pieceIds]
    );

    return {
      assigned: assignedCount,
      skipped,
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
    resinWasteMl?: number
  ) {
    const pieceRes = await this.db.query<{
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
    }>(
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
        `Only a printing or completed piece can be marked failed (current: '${piece.status}').`
      );
    }
    if (piece.bed_id) {
      throw new BadRequestException(
        "This piece is part of a bed — mark the bed failed from the Advanced workspace instead."
      );
    }
    if (requeueTo === "assigned" && !piece.assigned_printer_id) {
      throw new BadRequestException(
        "This piece has no assigned printer to return to — send it back to pending instead."
      );
    }

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
    const resinTankId = piece.resin_tank_id;

    await this.db.transaction(async (client) => {
      // Mirrors the spool branch below: a 'done' resin piece already had its
      // planned volume deducted at completion, so restore that first and the net
      // change equals the measured waste. A 'printing' piece was never deducted.
      if (isResin && resinTankId) {
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
            pieceId,
            orderId: piece.order_id,
            tankAssetId: resinTankId,
            ml: resinMl,
          });
        }
      }
      const reserved = await client.query<{ spool_asset_id: string; planned_grams: string | null }>(
        `SELECT spool_asset_id, planned_grams
           FROM order_piece_spools
          WHERE company_id = $1 AND piece_id = $2`,
        [companyId, pieceId]
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
      // Persist the measured waste and book it to the ledger (DR Filament Waste
      // / CR Inventory) in THIS transaction, so the loss record, its journal
      // entry and the re-queue are all-or-nothing. Reads asset_instances cost,
      // not the asset_stock grams we just changed, so ordering is irrelevant.
      await this.finance.recordFilamentWaste(client, companyId, userId, {
        pieceId,
        orderId: piece.order_id,
        wasteBySpool: wasteEvents
      });
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
      // Re-queue. Both targets clear the schedule + execution stamps and the
      // slicer file (a re-print starts clean). 'assigned' keeps the printer +
      // nozzle so the operator just re-drops the g-code; 'pending' wipes them.
      // The resin volume is slicer metadata, so it clears with the rest of it;
      // post_process_state clears because a re-queued print has nothing to wash.
      // The TANK follows the printer: kept on 'assigned' (the operator just
      // re-drops the file), cleared on 'pending' (a clean slate).
      if (requeueTo === "assigned") {
        await client.query(
          `
            UPDATE order_pieces
               SET status                        = 'assigned',
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
          [companyId, pieceId]
        );
      } else {
        await client.query(
          `
            UPDATE order_pieces
               SET status                        = 'pending',
                   assigned_printer_id           = NULL,
                   assigned_nozzle_asset_id      = NULL,
                   resin_tank_id                 = NULL,
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
          [companyId, pieceId]
        );
      }
      // Re-derive the order's rollup status inside the same transaction.
      await recomputeOrderStatusTx(client, companyId, piece.order_id);
    });

    const totalWaste = [...wasteBySpool.values()].reduce((sum, g) => sum + g, 0);
    // The history line quotes the material's own unit — "180 ml resin wasted" is
    // the fact; "180 g" would be a different (and wrong) claim.
    const wastePhrase = isResin
      ? `${Math.round(resinMl)}ml resin wasted`
      : `${Math.round(totalWaste)}g filament wasted`;
    await this.logFailure(
      companyId,
      piece.order_id,
      piece.order_number,
      pieceId,
      piece.piece_name,
      `Piece "${piece.piece_name}" marked failed — ${wastePhrase}, returned to ${requeueTo}.`
    );

    return {
      piece_id: pieceId,
      status: requeueTo,
      waste_grams: totalWaste,
      waste_resin_ml: resinMl,
    };
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
    bedId?: string
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
    if (pieceIds && pieceIds.length > 0) {
      const reqRes = await this.db.query<{
        required_print_technology: string | null;
        required_multicolor_capable: boolean | null;
        requires_multicolor: boolean | null;
        required_nozzle_diameter_mm: number | null;
        required_nozzle_material: string | null;
      }>(
        `
          SELECT required_print_technology, required_multicolor_capable, requires_multicolor,
                 required_nozzle_diameter_mm, required_nozzle_material
          FROM order_pieces
          WHERE company_id = $1 AND piece_id = ANY($2::uuid[])
        `,
        [companyId, pieceIds]
      );
      for (const r of reqRes.rows) {
        if (r.required_print_technology) techFamilies.add(techFamily(r.required_print_technology));
        if (r.required_multicolor_capable || r.requires_multicolor) requireMulticolor = true;
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
    if (bedId) {
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
          WHERE company_id = $1 AND bed_id = $2
        `,
        [companyId, bedId]
      );
      for (const r of bedRes.rows) {
        if (r.required_print_technology) techFamilies.add(techFamily(r.required_print_technology));
        if (r.required_multicolor_capable) requireMulticolor = true;
        const dia = r.required_nozzle_diameter_mm != null ? Number(r.required_nozzle_diameter_mm) : null;
        const mat = r.required_nozzle_material;
        if (dia == null && !mat) continue;
        const key = reqKey(dia, mat);
        nozzleReq.set(key, {
          key,
          diameter_mm: dia,
          material: mat,
          label: [dia != null ? `${dia}mm` : null, mat].filter(Boolean).join(" ") || "Any nozzle",
          piece_count: 1,
        });
      }
    }
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
      return { window_end: windowEnd.toISOString(), printers: [] };
    }
    const requiredFamily = techFamilies.size === 1 ? [...techFamilies][0] : null;

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
      running_until: string | null;
      busy_minutes: string | number;
    }>(
      `
        SELECT
          pi.printer_id,
          pi.brand,
          pi.model,
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
        GROUP BY pi.printer_id, pi.brand, pi.model
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
      requirements,
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
    }
  ) {
    const { items, printers } = await this.listSchedulable(companyId, input.printer_ids);
    if (items.length === 0) {
      return {
        placed: [], skipped: [], ordered_by: "least_slack_first" as const,
        dry_run: input.dry_run === true,
        min_margin_minutes: input.min_margin_minutes ?? 5,
        nozzle_swaps: 0, span_minutes: 0, utilisation: [],
        printers,
      };
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
    const now = Date.now();

    const printerBusy = new Map<string, Interval[]>();
    const nozzleBusy = new Map<string, Interval[]>();
    // Filament spools AND resin tanks. Both are material sources that can only
    // feed one print at a time, both are keyed by asset id, and the packer's
    // question of them is identical — "is this thing free in that window?" — so
    // they share one map rather than duplicating the whole fit loop.
    const materialBusy = new Map<string, Interval[]>();
    const push = (m: Map<string, Interval[]>, k: string | null, iv: Interval) => {
      if (!k) return;
      const arr = m.get(k) ?? [];
      arr.push(iv);
      m.set(k, arr);
    };

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
    const spoolRes = await this.db.query<{ spool_asset_id: string; piece_id: string; bed_id: string | null }>(
      `SELECT ops.spool_asset_id, ops.piece_id, op.bed_id
         FROM order_piece_spools ops
         JOIN order_pieces op ON op.piece_id = ops.piece_id
        WHERE ops.company_id = $1`,
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
      }>(
        `SELECT op.piece_id, op.piece_name, op.status, op.assigned_printer_id,
                op.assigned_nozzle_asset_id, op.slicer_print_time_minutes,
                op.required_nozzle_diameter_mm, op.required_nozzle_material,
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
        });
      }
    }
    if (bedIds.length > 0) {
      const r = await this.db.query<{
        bed_id: string; bed_name: string; status: string;
        assigned_printer_id: string | null; assigned_nozzle_asset_id: string | null;
        slicer_print_time_minutes: number | null; deadline: string | null;
        required_nozzle_diameter_mm: number | null; required_nozzle_material: string | null;
      }>(
        `SELECT bed_id, bed_name, status, assigned_printer_id, assigned_nozzle_asset_id,
                slicer_print_time_minutes, required_nozzle_diameter_mm,
                required_nozzle_material, effective_deadline::text AS deadline
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
      const r = await this.db.query<{ bed_id: string; spool_asset_id: string }>(
        `SELECT DISTINCT op.bed_id, ops.spool_asset_id
           FROM order_piece_spools ops
           JOIN order_pieces op ON op.piece_id = ops.piece_id
          WHERE ops.company_id = $1 AND op.bed_id = ANY($2::uuid[])`,
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

    for (const c of ordered) {
      if (c.status !== "ready") {
        skipped.push({
          id: c.id, is_bed: c.is_bed, name: c.name,
          reason: c.status === "scheduled" || c.status === "printing"
            ? "already on the board"
            : `not ready yet ('${c.status}' — needs printer, nozzle and print data)`,
        });
        continue;
      }
      // A bed is a piece as far as scheduling is concerned: it occupies one
      // printer, mounts one nozzle and draws from real spools, so it clears the
      // same gate. It used to be waved through without a nozzle, which meant a
      // bed booked no nozzle time and could be double-booked against a piece
      // using the very same nozzle.
      if (!c.printer_id || c.minutes == null || c.minutes <= 0 || !c.nozzle_id) {
        skipped.push({ id: c.id, is_bed: c.is_bed, name: c.name, reason: "missing printer/nozzle/print time" });
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
              WHERE ops.company_id = $1 AND op.bed_id = $2`,
            [companyId, c.id]
          );
          return r.rows.map((x) => x.spool_asset_id);
        }
        const r = await this.db.query<{ spool_asset_id: string }>(
          `SELECT spool_asset_id FROM order_piece_spools WHERE company_id = $1 AND piece_id = $2`,
          [companyId, c.id]
        );
        return r.rows.map((x) => x.spool_asset_id);
      };
      mySpools = (c.is_bed ? reservedByBed.get(c.id) : reservedByPiece.get(c.id)) ?? [];
      if (mySpools.length === 0) {
        const what = c.is_bed ? "bed" : "piece";
        if (dryRun) {
          // Don't reserve — ask the planner which spool(s) the commit WOULD
          // take, so the simulated placement still honours spool exclusivity
          // instead of ignoring a constraint the real run enforces.
          willReserveSpool = true;
          try {
            const plan = c.is_bed
              ? await this.bedsService.filamentPlan(companyId, c.id)
              : await this.jobsService.filamentPlan(companyId, c.id);
            mySpools = plan.multicolor
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
      const printerIvs = printerBusy.get(c.printer_id) ?? [];
      const materialIvs = mySpools.flatMap((sid) => materialBusy.get(sid) ?? []);
      const earliestWith = (nozzleId: string | null): number =>
        earliestFitWithin(
          [...printerIvs, ...(nozzleId ? nozzleBusy.get(nozzleId) ?? [] : []), ...materialIvs],
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
      const chosenNozzle = nozzleChoice.id;
      const startMs = nozzleChoice.startMs;
      const nozzleMovedFrom = nozzleChoice.movedFromPrinterId;
      const chosenLabel = nozzleChoice.label;
      const nozzleSwapped = nozzleChoice.swapped;

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
        try {
          if (c.is_bed) await this.bedsService.schedule(companyId, c.id, { start_at: startIso });
          else await this.jobsService.schedule(companyId, c.id, { start_at: startIso });
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
      utilisation,
    };
  }
}
