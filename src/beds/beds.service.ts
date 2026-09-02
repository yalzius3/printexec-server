import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import {
  StorageFilesService,
  keysFromRows,
  BED_FILE_FIELDS,
  PIECE_FILE_FIELDS
} from "../storage/storage-files.service";
import {
  recordOrderHistory,
  recordOrderHistoryBatch,
  type OrderHistoryEvent
} from "../common/order-history";
import {
  quoteAssumedMeta,
  releasePieceSpoolsTx,
  recomputeOrderStatusTx,
  releasePrinterTx,
  deleteEmptyBedTx
} from "../common/cascade";
import { FinanceService } from "../finance/finance.service";
import { JobsService, isResinTech, materialFamily, type NozzleSwitch } from "../jobs/jobs.service";
import { MAX_PLATE_TRIAGE, pieceShares, requeueStatus, settlePlate, splitAcrossSpools } from "./outcome";
import { PIECE_POST_PROCESS_TRANSITIONS } from "../order-pieces/order-pieces.service";
import type { FindCandidatesInput, ReserveSpoolsInput } from "../jobs/jobs.schemas";
import type {
  CreateBedInput,
  UpdateBedInput,
  UpdateBedFilesInput,
} from "./beds.schemas";

// ────────────────────────────────────────────────────────────────
// Row shapes
// ────────────────────────────────────────────────────────────────
export interface BedRow {
  bed_id: string;
  company_id: string;
  bed_name: string;
  description: string | null;
  required_print_technology: string;
  required_filament_ref_id: string | null;
  required_filament_material: string | null;
  required_filament_label: string | null;
  required_nozzle_diameter_mm: number | null;
  required_nozzle_material: string | null;
  required_multicolor_capable: boolean;
  effective_deadline: string;
  stl_file_url: string | null;
  slicer_file_url: string | null;
  slicer_print_time_minutes: number | null;
  slicer_filament_used_grams: number | null;
  // ── Resin (MSLA/SLA) ──────────────────────────────────────────────────────
  // A resin plate's counterparts of the two fields above it: it pours from one
  // tank and draws millilitres, and it has no nozzle and no spool at all. Null
  // on every FDM bed, and vice-versa — a bed is one technology by construction.
  resin_tank_id: string | null;
  resin_tank_label: string | null;
  slicer_resin_used_ml: number | null;
  assigned_printer_id: string | null;
  assigned_printer_label: string | null;
  assigned_printer_technology: string | null;
  assigned_printer_marker: string | null;
  assigned_nozzle_asset_id: string | null;
  status:
    | "pending" | "assigned" | "ready" | "scheduled"
    | "printing" | "done" | "failed" | "cancelled" | "disassembled";
  scheduled_at: string | null;
  scheduled_start_at: string | null;
  scheduled_end_at: string | null;
  print_started_at: string | null;
  print_completed_at: string | null;
  created_at: string;
  last_updated_at: string;
  piece_count: number;
  // Aggregate shipping/fulfilment stage of the bed's DONE pieces — the LEAST
  // advanced stage among them (none < ready_for_shipping < out_for_shipping <
  // fulfilled), so the bed reads as "done" until every piece has shipped.
  // 'none' when the bed has no done pieces. Mirrors a piece's fulfilment_status.
  fulfilment_status: string;
  // Aggregate resin post-processing stage, derived by the same least-advanced
  // rule. NULL on any bed with no resin pieces, which is what keeps FDM beds
  // free of a wash/cure affordance.
  post_process_state: string | null;
  post_process_state_entered_at: string | null;
  // Source orders / customers of this bed's constituent pieces (a bed may span
  // more than one order). Comma-joined, distinct, ordered. NULL if no pieces.
  order_references: string | null;
  // The same orders' HUMAN NAMES (orders.title), which is what the Jobs
  // surfaces actually draw — the serial is identity and lives in the tooltip.
  //
  // A PARALLEL LIST, not a paired one: string_agg aggregates the two columns
  // independently and an untitled order contributes nothing here, so this can
  // be SHORTER than order_references and the two must never be zipped. The
  // client's bedOrderLabel() counts off the serials for exactly that reason.
  order_titles: string | null;
  customer_names: string | null;
}

/** Payload of POST /beds/:bedId/outcome — see BedsService.recordOutcome. */
export interface BedOutcomeInput {
  pieces: {
    piece_id: string;
    outcome: "done" | "failed" | "not_started";
    waste?: number | undefined;
  }[];
  failed_requeue_to: "assigned" | "pending";
  not_started_requeue_to: "assigned" | "pending";
  failure_reason?: string | undefined;
  actual_print_time_minutes?: number | undefined;
}

/** One row of the triage console. `share` is the server's answer to "how much
 *  of the plate is this piece" — the client never derives it. */
export interface BedOutcomePlanPiece {
  piece_id: string;
  piece_name: string;
  order_id: string;
  order_number: string;
  /** The order's human name. Null for an order nobody titled — the client
   *  falls back to the number. */
  order_title: string | null;
  customer_name: string | null;
  order_deadline: string | null;
  share: number;
}

/** Response of GET /beds/:bedId/outcome-plan. */
export interface BedOutcomePlan {
  bed_id: string;
  bed_name: string;
  status: string;
  unit: "g" | "ml";
  is_resin: boolean;
  plate_quantity: number;
  has_printer: boolean;
  printer_label: string | null;
  printer_technology: string | null;
  printer_marker: string | null;
  pieces: BedOutcomePlanPiece[];
}

/** What the console shows the operator once the plate has been settled. */
export interface BedOutcomeResult {
  bed_id: string;
  bed_status: "done" | "failed";
  done: number;
  failed: number;
  not_started: number;
  failed_requeued_to: "assigned" | "pending";
  not_started_requeued_to: "assigned" | "pending";
  /** The plate's own unit — 'g' on filament, 'ml' on resin. */
  unit: "g" | "ml";
  plate_quantity: number;
  consumed: number;
  wasted: number;
  returned_to_stock: number;
  waste_cost: number;
}

interface PieceForBed {
  piece_id: string;
  piece_name: string;
  order_id: string;
  order_number: string;
  order_deadline: string;
  required_print_technology: string | null;
  required_filament_ref_id: string | null;
  required_filament_material: string | null;
  required_nozzle_diameter_mm: number | null;
  required_nozzle_material: string | null;
  required_multicolor_capable: boolean;
  status: string;
  bed_id: string | null;
}

// Forward-only shipping/fulfilment NFA (mirrors the per-piece NFA in
// order-pieces.service). Keyed by the current stage; value = allowed next stages.
//   done(none) -> ready_for_shipping | fulfilled   (fulfilled = on-the-spot pickup)
//   ready_for_shipping -> out_for_shipping
//   out_for_shipping   -> fulfilled
const BED_FULFILMENT_TRANSITIONS: Record<string, readonly string[]> = {
  none: ["ready_for_shipping", "fulfilled"],
  ready_for_shipping: ["out_for_shipping"],
  out_for_shipping: ["fulfilled"]
};
const BED_FULFILMENT_LABELS: Record<string, string> = {
  ready_for_shipping: "ready for shipping",
  out_for_shipping: "out for shipping",
  fulfilled: "fulfilled"
};

/**
 * Turn a database-level refusal from the plate settle into something an
 * operator can act on.
 *
 * A 23514 (CHECK violation) at this point is always the same story: detaching a
 * piece from its plate revokes the `OR bed_id IS NOT NULL` escape that every
 * status constraint on order_pieces carries, and the row landed without one of
 * the columns that escape was covering for. The transaction has already rolled
 * back by the time this runs, so the plate is untouched and re-opening it is a
 * safe instruction rather than a hopeful one.
 *
 * The constraint name is kept in the message on purpose: it is the one token
 * that turns a support conversation into a one-line answer, and it means
 * nothing to an attacker. Anything that is not a CHECK violation is rethrown
 * exactly as it came — this is a translator, never a swallower.
 */
function asSettleFailure(e: unknown): unknown {
  const err = e as { code?: string; constraint?: string } | null;
  if (err?.code !== "23514") return e;
  const named = err.constraint ? ` (${err.constraint})` : "";
  return new ConflictException(
    "This plate couldn't be settled: one of its pieces can't hold the state it " +
      `was given once it leaves the plate${named}. Nothing was changed — reopen ` +
      "the plate and try again, and if it keeps happening send this message to support."
  );
}

@Injectable()
export class BedsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly jobsService: JobsService,
    // Books measured plate waste to the ledger (recordOutcome), the same way
    // SimpleJobsService books a single failed piece. One-way: FinanceModule
    // reaches Orders and Email and neither reaches back here, so no cycle.
    private readonly finance: FinanceService,
    private readonly storage: StorageFilesService
  ) {}

  // ──────────────────────────────────────────────────────────
  // POST /api/beds/:bedId/candidates — same 4-stage filter as pieces,
  // driven by the bed's own required specs. Beds aren't in order_pieces
  // so excludePieceId is null.
  // ──────────────────────────────────────────────────────────
  async findCandidates(companyId: string, bedId: string, input: FindCandidatesInput) {
    const bed = await this.loadBed(companyId, bedId);
    return this.jobsService.findCandidatesCore(
      companyId,
      {
        deadline: bed.effective_deadline,
        technology: bed.required_print_technology,
        material: bed.required_filament_material,
        nozzleDiameterMm: bed.required_nozzle_diameter_mm,
        nozzleMaterial: bed.required_nozzle_material,
        multicolor: bed.required_multicolor_capable,
        excludePieceId: null,
      },
      input
    );
  }

  // Filament/spool plan for a bed — reuses the shared planner so the spool
  // involvement (single/combine/insufficient + depletion) shows when scheduling
  // a bed, exactly like a piece.
  async filamentPlan(companyId: string, bedId: string) {
    const bed = await this.loadBed(companyId, bedId);
    // A resin plate has no filament plan to make — it pours from one tank, which
    // the operator links directly. Returning the FDM planner's "none" verdict
    // here made the scheduling board demand a filament material for a plate that
    // can never have one, and left its Done button disabled forever. `null` is
    // the honest answer, and the board reads it as "this job has no spools".
    if (isResinTech(bed.required_print_technology)) return null;
    // Beds print as one plate from a single material — always single-color, so
    // we tag the plan with multicolor:false to match the piece plan's shape.
    const plan = await this.jobsService.filamentPlanCore(
      companyId,
      bed.required_filament_material,
      bed.slicer_filament_used_grams != null ? Number(bed.slicer_filament_used_grams) : null
    );
    // A bed's reservation is anchored on its first child piece — read the real
    // order_piece_spools rows from there so "Reserved ✓" reflects the DB, not the
    // suggested plan.
    const anchorPieceId = await this.bedAnchorPieceId(companyId, bedId);
    const reserved_allocation = anchorPieceId
      ? [...(await this.jobsService.reservedSpoolsBySeq(companyId, anchorPieceId)).values()].flat()
      : [];
    return { multicolor: false as const, ...plan, reserved_allocation };
  }

  // ──────────────────────────────────────────────────────────
  // RESERVE physical spool(s) for a BED. A bed prints as one plate, so the
  // whole reservation is anchored on the bed's first child piece (the
  // order_piece_spools ledger is keyed by piece). Mirrors the piece reserve:
  // resolve allocations (explicit or auto-plan), validate material/free grams,
  // then transactionally release any prior reservation and re-reserve, bumping
  // asset_stock.reserved_grams. Released on unschedule/cancel, consumed on done.
  // ──────────────────────────────────────────────────────────
  async reserveSpools(
    companyId: string,
    bedId: string,
    input: ReserveSpoolsInput
  ): Promise<BedRow> {
    const bed = await this.loadBed(companyId, bedId);
    if (isResinTech(bed.required_print_technology)) {
      throw new BadRequestException(
        "A resin bed draws from a tank, not a spool — link a resin tank instead."
      );
    }
    if (!bed.required_filament_material) {
      throw new BadRequestException("Pick a filament material for the bed before reserving a spool.");
    }
    const needed = bed.slicer_filament_used_grams != null ? Number(bed.slicer_filament_used_grams) : null;
    if (needed == null || needed <= 0) {
      throw new BadRequestException("Upload a slicer file first — filament grams are needed to reserve a spool.");
    }
    if (bed.status === "done" || bed.status === "failed" || bed.status === "cancelled" || bed.status === "disassembled") {
      throw new ConflictException(`Cannot reserve a spool on a '${bed.status}' bed.`);
    }
    const anchorPieceId = await this.bedAnchorPieceId(companyId, bedId);
    if (!anchorPieceId) {
      throw new BadRequestException("Bed has no pieces to anchor a reservation to.");
    }
    const wantFamily = materialFamily(bed.required_filament_material);

    let allocations: Array<{ spool_asset_id: string; grams: number }> = input.allocations ?? [];
    if (allocations.length === 0) {
      const plan = await this.jobsService.filamentPlanCore(companyId, bed.required_filament_material, needed);
      if (plan.plan === "insufficient" || plan.plan === "none") {
        throw new BadRequestException("Not enough free filament of this material in inventory to reserve.");
      }
      allocations = plan.allocation.map((a) => ({ spool_asset_id: a.spool_asset_id, grams: a.grams }));
    }
    const totalAllocated = allocations.reduce((s, a) => s + a.grams, 0);
    if (totalAllocated + 0.001 < needed) {
      throw new BadRequestException(`Allocated ${Math.round(totalAllocated)}g is less than the ${Math.round(needed)}g needed.`);
    }

    await this.databaseService.transaction(async (client) => {
      // Drop any prior reservation for every child piece, then re-reserve onto
      // the anchor — so re-picking a spool can never double-count.
      const childIds = await this.bedChildPieceIds(companyId, bedId, client);
      for (const pid of childIds) {
        await releasePieceSpoolsTx(client, companyId, pid);
      }
      let seq = 1;
      for (const a of allocations) {
        const spoolRes = await client.query<{
          remaining: string | null; reserved: string | null; material_type: string | null; type: string; status: string;
        }>(
          `SELECT COALESCE(ast.remaining_grams, ai.initial_grams) AS remaining,
                  COALESCE(ast.reserved_grams, 0) AS reserved,
                  fr.material_type, ai.asset_type AS type,
                  COALESCE(ast.status, 'available') AS status
             FROM asset_instances ai
             LEFT JOIN asset_stock ast ON ast.asset_id = ai.asset_id
             LEFT JOIN filament_reference fr ON fr.filament_ref_id = ai.filament_ref_id
            WHERE ai.company_id = $1 AND ai.asset_id = $2`,
          [companyId, a.spool_asset_id]
        );
        const s = spoolRes.rows[0];
        if (!s || s.type !== "filament_spool") throw new BadRequestException("Selected spool not found.");
        if (!s.material_type || materialFamily(s.material_type) !== wantFamily) {
          throw new BadRequestException(`A chosen spool's material (${s.material_type ?? "unknown"}) doesn't match the bed's material (${bed.required_filament_material}).`);
        }
        if (s.status === "empty" || s.status === "damaged") throw new BadRequestException(`A chosen spool is ${s.status}.`);
        const free = Math.max(0, Number(s.remaining ?? 0) - Number(s.reserved ?? 0));
        if (a.grams - 0.001 > free) throw new BadRequestException(`A chosen spool has only ${Math.round(free)}g free (needs ${Math.round(a.grams)}g).`);

        await client.query(
          `INSERT INTO order_piece_spools (company_id, piece_id, spool_asset_id, planned_grams, sequence_order)
           VALUES ($1, $2, $3, $4, $5)`,
          [companyId, anchorPieceId, a.spool_asset_id, a.grams, seq++]
        );
        // NB: asset_stock.reserved_grams is recomputed from the ledger by a DB
        // trigger on this insert (sum of planned_grams across scheduled/printing
        // pieces). We must NOT also increment it manually here — doing so double-
        // counts (a 90g bed showed 180g reserved).
      }
    });
    return this.loadBed(companyId, bedId);
  }

  /** Release a bed's spool reservation across all its child pieces. */
  async releaseSpools(companyId: string, bedId: string): Promise<BedRow> {
    await this.databaseService.transaction(async (client) => {
      const childIds = await this.bedChildPieceIds(companyId, bedId, client);
      for (const pid of childIds) {
        await releasePieceSpoolsTx(client, companyId, pid);
      }
    });
    return this.loadBed(companyId, bedId);
  }

  /** The bed's oldest child piece — the anchor for its reservation ledger. */
  private async bedAnchorPieceId(companyId: string, bedId: string): Promise<string | null> {
    const res = await this.databaseService.query<{ piece_id: string }>(
      `SELECT piece_id FROM order_pieces
        WHERE company_id = $1 AND bed_id = $2
        ORDER BY created_at ASC, piece_id ASC
        LIMIT 1`,
      [companyId, bedId]
    );
    return res.rows[0]?.piece_id ?? null;
  }

  /** All child piece ids of a bed (within an open transaction). */
  private async bedChildPieceIds(
    companyId: string,
    bedId: string,
    client: import("pg").PoolClient
  ): Promise<string[]> {
    const res = await client.query<{ piece_id: string }>(
      `SELECT piece_id FROM order_pieces WHERE company_id = $1 AND bed_id = $2`,
      [companyId, bedId]
    );
    return res.rows.map((r) => r.piece_id);
  }

  /** Consume a bed's reserved filament on completion (reserved → deducted). */
  private async consumeSpoolsTx(
    client: import("pg").PoolClient,
    companyId: string,
    bedId: string
  ): Promise<void> {
    const childIds = await this.bedChildPieceIds(companyId, bedId, client);
    if (childIds.length === 0) return;
    const rows = await client.query<{ spool_asset_id: string; planned_grams: string }>(
      `SELECT spool_asset_id, planned_grams FROM order_piece_spools
        WHERE company_id = $1 AND piece_id = ANY($2::uuid[])`,
      [companyId, childIds]
    );
    for (const r of rows.rows) {
      const g = Number(r.planned_grams);
      await client.query(
        `UPDATE asset_stock
            SET reserved_grams  = GREATEST(0, COALESCE(reserved_grams, 0) - $2),
                remaining_grams = GREATEST(0, COALESCE(remaining_grams, 0) - $2),
                status = CASE WHEN GREATEST(0, COALESCE(remaining_grams,0) - $2) <= 0 THEN 'empty' ELSE status END
          WHERE asset_id = $1`,
        [r.spool_asset_id, g]
      );
    }
    await client.query(
      `DELETE FROM order_piece_spools WHERE company_id = $1 AND piece_id = ANY($2::uuid[])`,
      [companyId, childIds]
    );
  }

  // ──────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────

  /** Pull a single bed with the joined printer label + piece count. */
  private async loadBed(companyId: string, bedId: string): Promise<BedRow> {
    const res = await this.databaseService.query<BedRow>(
      `${this.bedSelectSql("WHERE pb.company_id = $1 AND pb.bed_id = $2")}`,
      [companyId, bedId]
    );
    if (res.rowCount === 0) throw new NotFoundException("Bed not found.");
    return res.rows[0]!;
  }

  /**
   * Push a status onto every child piece of a bed. Best-effort: if the
   * bedded-piece check-constraint migration (`db_fix_bedded_piece_constraints.sql`)
   * hasn't been applied yet, the UPDATE can violate a check constraint
   * (SQLSTATE 23514). We swallow that specific error so the bed operation
   * still succeeds — the pieces will sync once the migration runs. Any other
   * error is rethrown.
   */
  private async propagatePieceStatus(companyId: string, bedId: string, status: string): Promise<void> {
    try {
      await this.databaseService.query(
        `UPDATE order_pieces SET status = $3 WHERE company_id = $1 AND bed_id = $2`,
        [companyId, bedId, status]
      );
    } catch (e) {
      if ((e as { code?: string } | null)?.code === "23514") return;
      throw e;
    }
  }

  private bedSelectSql(whereClause: string, orderBy = "pb.created_at DESC"): string {
    return `
      SELECT
        pb.bed_id, pb.company_id, pb.bed_name, pb.description,
        pb.required_print_technology, pb.required_filament_ref_id,
        pb.required_filament_material,
        CASE WHEN fr.filament_ref_id IS NOT NULL
             THEN fr.brand || ' ' || fr.material_type || ' · ' || fr.color
             ELSE NULL END AS required_filament_label,
        pb.required_nozzle_diameter_mm, pb.required_nozzle_material,
        pb.required_multicolor_capable,
        pb.effective_deadline::text AS effective_deadline,
        pb.stl_file_url, pb.slicer_file_url,
        pb.slicer_print_time_minutes, pb.slicer_filament_used_grams,
        pb.resin_tank_id,
        pb.slicer_resin_used_ml,
        -- Same label expression the piece query uses, so a tank reads
        -- identically wherever it appears.
        NULLIF(TRIM(CONCAT_WS(' ', rt.resin_brand, rt.resin_type, rt.resin_color)), '')
          AS resin_tank_label,
        pb.assigned_printer_id,
        CASE WHEN pi.printer_id IS NOT NULL
             THEN pi.brand || ' ' || pi.model
             ELSE NULL END AS assigned_printer_label,
        pi.print_technology AS assigned_printer_technology,
        pi.marker           AS assigned_printer_marker,
        pb.assigned_nozzle_asset_id,
        pb.status,
        pb.scheduled_at,
        pb.scheduled_start_at, pb.scheduled_end_at,
        pb.print_started_at, pb.print_completed_at,
        pb.created_at, pb.last_updated_at,
        COALESCE(c.piece_count, 0)::int AS piece_count,
        COALESCE(ful.fulfilment_status, 'none') AS fulfilment_status,
        pp.post_process_state,
        pp.post_process_state_entered_at,
        src.order_references,
        src.order_titles,
        src.customer_names
      FROM print_beds pb
      LEFT JOIN printer_instances pi ON pi.printer_id = pb.assigned_printer_id
      LEFT JOIN filament_reference fr ON fr.filament_ref_id = pb.required_filament_ref_id
      LEFT JOIN asset_instances rt ON rt.asset_id = pb.resin_tank_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS piece_count FROM order_pieces WHERE bed_id = pb.bed_id
      ) c ON TRUE
      LEFT JOIN LATERAL (
        -- The bed's shipping stage = the LEAST advanced fulfilment_status across
        -- its DONE pieces. Rank none/ready/out/fulfilled 1..4, take MIN, map back.
        -- A bed therefore only reads as "shipped" once every piece has shipped.
        SELECT (ARRAY['none','ready_for_shipping','out_for_shipping','fulfilled'])[
          MIN(CASE COALESCE(opf.fulfilment_status, 'none')
                WHEN 'fulfilled' THEN 4
                WHEN 'out_for_shipping' THEN 3
                WHEN 'ready_for_shipping' THEN 2
                ELSE 1 END)
        ] AS fulfilment_status
        FROM order_pieces opf
        WHERE opf.bed_id = pb.bed_id AND opf.status = 'done'
      ) ful ON TRUE
      LEFT JOIN LATERAL (
        -- Same least-advanced rule for resin post-processing: a bed is only
        -- "cured" once every piece on it is. NULL when the bed holds no resin
        -- pieces, which is what keeps FDM beds free of a wash/cure badge.
        SELECT (ARRAY['print_done','washed','cured'])[
          MIN(CASE opp.post_process_state
                WHEN 'cured' THEN 3
                WHEN 'washed' THEN 2
                ELSE 1 END)
        ] AS post_process_state,
        MIN(opp.post_process_state_entered_at) AS post_process_state_entered_at
        FROM order_pieces opp
        WHERE opp.bed_id = pb.bed_id
          AND opp.status = 'done'
          AND opp.post_process_state IS NOT NULL
      ) pp ON TRUE
      LEFT JOIN LATERAL (
        -- Distinct source orders + customers of this bed's pieces (may span
        -- multiple orders), comma-joined for display.
        SELECT
          string_agg(DISTINCT o.order_number, ', ' ORDER BY o.order_number) AS order_references,
          -- NULLIF(TRIM(...)) so an order titled with spaces contributes
          -- nothing rather than an empty member the client has to filter out.
          string_agg(DISTINCT NULLIF(TRIM(o.title), ''), ', ' ORDER BY NULLIF(TRIM(o.title), '')) AS order_titles,
          string_agg(DISTINCT COALESCE(
            NULLIF(cu.business_name, ''),
            NULLIF(TRIM(CONCAT_WS(' ', cu.first_name, cu.last_name)), '')
          ), ', ') AS customer_names
        FROM order_pieces opx
        JOIN orders o ON o.order_id = opx.order_id
        LEFT JOIN customers cu ON cu.customer_id = o.customer_id
        WHERE opx.bed_id = pb.bed_id
      ) src ON TRUE
      ${whereClause}
      ORDER BY ${orderBy}
    `;
  }

  // ──────────────────────────────────────────────────────────
  // POST /api/beds  — create a bed from a set of pieces.
  //
  // Hard constraints (rejected otherwise):
  //   - ≥ 2 pieces (enforced by Zod)
  //   - All pieces must belong to the caller's company
  //   - None of them can already be in a bed
  //   - All must share the same required_print_technology
  //   - All must currently be in a status that's allowed to be bedded
  //     (we permit: pending, assigned, ready — anything not yet on the
  //     timeline). Pieces already 'scheduled'/'printing'/terminal are
  //     rejected so the operator un-schedules first.
  //
  // Soft constraints (warnings via response, not rejection — TBD):
  //   - filament/nozzle equality (we just enforce them now; can relax later)
  // ──────────────────────────────────────────────────────────
  async create(
    companyId: string,
    input: CreateBedInput,
    createdBy?: string
  ): Promise<BedRow> {
    const pieces = await this.fetchPiecesForBed(companyId, input.piece_ids);

    // ── Validate count + ownership
    if (pieces.length !== input.piece_ids.length) {
      throw new BadRequestException(
        "One or more pieces don't exist or belong to another company."
      );
    }

    // ── No already-bedded pieces
    const alreadyBedded = pieces.filter((p) => p.bed_id != null);
    if (alreadyBedded.length > 0) {
      throw new ConflictException(
        `Already in a bed: ${alreadyBedded.map((p) => p.piece_name).join(", ")}.`
      );
    }

    // ── All pieces must be in a "bed-able" status
    const ALLOWED_STATUSES = new Set(["pending", "assigned", "ready"]);
    const wrongStatus = pieces.filter((p) => !ALLOWED_STATUSES.has(p.status));
    if (wrongStatus.length > 0) {
      throw new ConflictException(
        `Cannot bed pieces in '${wrongStatus[0]!.status}' status (e.g. "${wrongStatus[0]!.piece_name}"). Unschedule them first.`
      );
    }

    // ── Technology resolution.
    // Distinct non-null technologies among the pieces:
    const distinctTechs = Array.from(
      new Set(pieces.map((p) => p.required_print_technology).filter((t): t is string => !!t))
    );
    if (distinctTechs.length > 1) {
      throw new BadRequestException(
        `All pieces must share the same print technology. Found: ${distinctTechs.join(", ")}.`
      );
    }
    // The bed's technology: the pieces' shared tech if any, else the operator's
    // override. If neither, we can't proceed.
    const tech = distinctTechs[0] ?? input.technology ?? null;
    if (!tech) {
      throw new BadRequestException(
        "These pieces have no print technology set. Choose a technology for the bed and we'll apply it to them."
      );
    }
    // If pieces carry a tech but the operator also passed an override that
    // disagrees, reject — don't silently override real data.
    if (distinctTechs.length === 1 && input.technology && input.technology !== distinctTechs[0]) {
      throw new BadRequestException(
        `Pieces are ${distinctTechs[0]} but you chose ${input.technology}. Clear the override or pick matching pieces.`
      );
    }

    // ── Earliest deadline
    const deadlines = pieces.map((p) => p.order_deadline).filter(Boolean);
    if (deadlines.length === 0) {
      throw new BadRequestException("Bed pieces have no deadlines — cannot infer one for the bed.");
    }
    const effectiveDeadline = deadlines.sort()[0]!;

    // Inherit nozzle/filament/multicolor from the first piece. If pieces
    // disagree we still build the bed (the slicer file handles the real
    // packing) but the bed's "required" fields reflect the strictest
    // constraint — diameter is the LARGEST (more permissive printers
    // can't always print smaller diameters), multicolor is OR'd.
    const required_filament_ref_id = pieces[0]!.required_filament_ref_id;
    const required_filament_material = pieces[0]!.required_filament_material;
    const required_nozzle_diameter_mm = pieces
      .map((p) => Number(p.required_nozzle_diameter_mm ?? 0))
      .reduce((a, b) => Math.max(a, b), 0) || null;
    const required_nozzle_material = pieces[0]!.required_nozzle_material;
    const required_multicolor_capable = pieces.some((p) => p.required_multicolor_capable);

    return this.databaseService.transaction(async (client) => {
      const bedRes = await client.query<{ bed_id: string }>(
        `INSERT INTO print_beds (
            company_id, bed_name, description,
            required_print_technology, required_filament_ref_id, required_filament_material,
            required_nozzle_diameter_mm, required_nozzle_material,
            required_multicolor_capable, effective_deadline,
            status, created_by
         ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, 'pending', $11
         )
         RETURNING bed_id`,
        [
          companyId,
          input.bed_name,
          input.description ?? null,
          tech,
          required_filament_ref_id,
          required_filament_material,
          required_nozzle_diameter_mm,
          required_nozzle_material,
          required_multicolor_capable,
          effectiveDeadline,
          createdBy ?? null,
        ]
      );
      const bedId = bedRes.rows[0]!.bed_id;

      // Attach pieces to the bed AND clear their independent assignment +
      // scheduling — the bed now owns those concerns. Status goes back to
      // 'pending' from the bed's perspective (the piece itself doesn't need
      // a status while it's inside a bed; the bed has the lifecycle).
      // `required_print_technology` is back-filled to the resolved tech for any
      // piece that was missing one (COALESCE keeps existing values intact).
      await client.query(
        `UPDATE order_pieces
            SET bed_id = $1,
                required_print_technology = COALESCE(required_print_technology, $4),
                assigned_printer_id = NULL,
                assigned_nozzle_asset_id = NULL,
                slicer_print_time_minutes = NULL,
                slicer_filament_used_grams = NULL,
                slicer_file_url = NULL,
                slicer_file_uploaded_at = NULL,
                scheduled_start_at = NULL,
                scheduled_end_at = NULL,
                scheduled_at = NULL,
                status = 'pending'
          WHERE company_id = $2
            AND piece_id = ANY($3::uuid[])`,
        [bedId, companyId, input.piece_ids, tech]
      );

      // Read back with all joins.
      const fullRes = await client.query<BedRow>(
        this.bedSelectSql("WHERE pb.company_id = $1 AND pb.bed_id = $2"),
        [companyId, bedId]
      );
      return fullRes.rows[0]!;
    });
  }

  private async fetchPiecesForBed(
    companyId: string,
    pieceIds: string[]
  ): Promise<PieceForBed[]> {
    const res = await this.databaseService.query<PieceForBed>(
      `SELECT op.piece_id, op.piece_name, op.order_id,
              o.order_number, o.deadline::text AS order_deadline,
              op.required_print_technology, op.required_filament_ref_id,
              op.required_filament_material,
              op.required_nozzle_diameter_mm, op.required_nozzle_material,
              op.required_multicolor_capable, op.status, op.bed_id
         FROM order_pieces op
         JOIN orders o ON o.order_id = op.order_id
        WHERE op.company_id = $1
          AND op.piece_id = ANY($2::uuid[])`,
      [companyId, pieceIds]
    );
    return res.rows;
  }

  // ──────────────────────────────────────────────────────────
  // GET /api/beds  — list all beds for the company
  // ──────────────────────────────────────────────────────────
  async list(companyId: string): Promise<BedRow[]> {
    const res = await this.databaseService.query<BedRow>(
      this.bedSelectSql("WHERE pb.company_id = $1 AND pb.status != 'disassembled'"),
      [companyId]
    );
    return res.rows;
  }

  async get(companyId: string, bedId: string): Promise<BedRow> {
    return this.loadBed(companyId, bedId);
  }

  /** Get the constituent pieces of a bed. */
  async pieces(companyId: string, bedId: string) {
    await this.loadBed(companyId, bedId);
    const res = await this.databaseService.query(
      `SELECT op.piece_id, op.piece_name, op.description, op.status,
              op.order_id, o.order_number,
              -- The name the floor uses. The window draws this and keeps the
              -- number for the hover card; see the client's orderLabel().
              o.title AS order_title,
              op.cost_inputs,
              COALESCE(
                NULLIF(cu.business_name, ''),
                NULLIF(TRIM(CONCAT_WS(' ', cu.first_name, cu.last_name)), '')
              ) AS customer_name,
              o.deadline::text AS order_deadline
         FROM order_pieces op
         JOIN orders o ON o.order_id = op.order_id
         LEFT JOIN customers cu ON cu.customer_id = o.customer_id
        WHERE op.company_id = $1 AND op.bed_id = $2
        -- Grouped in the reading order, not the numbering order: the list is
        -- read as names, and clustering by serial scatters the names.
        ORDER BY COALESCE(NULLIF(TRIM(o.title), ''), o.order_number), op.piece_name`,
      [companyId, bedId]
    );
    return res.rows;
  }

  // ──────────────────────────────────────────────────────────
  // PATCH /api/beds/:bedId  — name/description only.
  // ──────────────────────────────────────────────────────────
  async update(
    companyId: string,
    bedId: string,
    input: UpdateBedInput
  ): Promise<BedRow> {
    await this.loadBed(companyId, bedId);
    const sets: string[] = [];
    const values: unknown[] = [companyId, bedId];
    if (input.bed_name !== undefined) {
      values.push(input.bed_name);
      sets.push(`bed_name = $${values.length}`);
    }
    if (input.description !== undefined) {
      values.push(input.description);
      sets.push(`description = $${values.length}`);
    }
    if (input.required_filament_material !== undefined) {
      const bed = await this.loadBed(companyId, bedId);
      if (bed.status === "printing" || bed.status === "done" || bed.status === "failed") {
        throw new ConflictException(`Cannot change filament on a '${bed.status}' bed.`);
      }
      values.push(input.required_filament_material);
      sets.push(`required_filament_material = $${values.length}`);
    }
    if (sets.length === 0) return this.loadBed(companyId, bedId);
    await this.databaseService.query(
      `UPDATE print_beds SET ${sets.join(", ")}
        WHERE company_id = $1 AND bed_id = $2`,
      values
    );
    return this.loadBed(companyId, bedId);
  }

  // ──────────────────────────────────────────────────────────
  // PATCH /api/beds/:bedId/files  — slicer + STL + slicer time + grams.
  // Same semantics as /jobs/:pieceId/files.
  // ──────────────────────────────────────────────────────────
  async updateFiles(
    companyId: string,
    bedId: string,
    input: UpdateBedFilesInput
  ): Promise<BedRow> {
    const bed = await this.loadBed(companyId, bedId);

    // The slicer metadata (print time + grams) is the schedule basis and can't
    // be cleared out from under a committed schedule. The slicer FILE, by
    // contrast, is an optional attachment and may be changed/removed anytime.
    const bedIsResin = isResinTech(bed.required_print_technology);
    if (
      (bed.status === "scheduled" || bed.status === "printing") &&
      (input.slicer_print_time_minutes === null ||
        input.slicer_filament_used_grams === null ||
        input.slicer_resin_used_ml === null)
    ) {
      throw new ConflictException(
        `Cannot clear the slicer time/${bedIsResin ? "resin volume" : "filament"} while the bed is '${bed.status}'. Unschedule first.`
      );
    }

    const sets: string[] = [];
    const values: unknown[] = [companyId, bedId];

    if (input.slicer_file_url !== undefined) {
      values.push(input.slicer_file_url);
      const idx = values.length;
      sets.push(`slicer_file_url = $${idx}`);
      sets.push(`slicer_file_uploaded_at = CASE WHEN $${idx}::text IS NULL THEN NULL ELSE now() END`);
    }
    if (input.stl_file_url !== undefined) {
      values.push(input.stl_file_url);
      const idx = values.length;
      sets.push(`stl_file_url = $${idx}`);
      sets.push(`stl_file_uploaded_at = CASE WHEN $${idx}::text IS NULL THEN NULL ELSE now() END`);
    }
    if (input.slicer_print_time_minutes !== undefined) {
      values.push(input.slicer_print_time_minutes);
      sets.push(`slicer_print_time_minutes = $${values.length}`);
    }
    if (input.slicer_filament_used_grams !== undefined) {
      values.push(input.slicer_filament_used_grams);
      sets.push(`slicer_filament_used_grams = $${values.length}`);
    }
    if (input.slicer_resin_used_ml !== undefined) {
      values.push(input.slicer_resin_used_ml);
      sets.push(`slicer_resin_used_ml = $${values.length}`);
    }
    if (input.resin_tank_id !== undefined) {
      values.push(input.resin_tank_id);
      sets.push(`resin_tank_id = $${values.length}::uuid`);
    }

    // Recompute readiness from the slicer METADATA whenever it changes. A bed in
    // a mutable planning state (assigned/ready) flips to 'ready' once it has
    // everything its TECHNOLOGY needs — printer + nozzle + time + grams for
    // filament, printer + time + millilitres + tank for resin — and falls back
    // to 'assigned' otherwise. The slicer/STL files never affect status.
    const metaChanged =
      input.slicer_print_time_minutes !== undefined ||
      input.slicer_filament_used_grams !== undefined ||
      input.slicer_resin_used_ml !== undefined ||
      input.resin_tank_id !== undefined;
    if (metaChanged && (bed.status === "assigned" || bed.status === "ready")) {
      const pick = <T,>(given: T | undefined, current: T): T => (given !== undefined ? given : current);
      const newTime = pick(input.slicer_print_time_minutes, bed.slicer_print_time_minutes);
      const ready = bedIsResin
        ? Boolean(bed.assigned_printer_id) &&
          newTime != null &&
          pick(input.slicer_resin_used_ml, bed.slicer_resin_used_ml) != null &&
          Boolean(pick(input.resin_tank_id, bed.resin_tank_id))
        : Boolean(bed.assigned_printer_id) && Boolean(bed.assigned_nozzle_asset_id) &&
          newTime != null &&
          pick(input.slicer_filament_used_grams, bed.slicer_filament_used_grams) != null;
      sets.push(`status = '${ready ? "ready" : "assigned"}'`);
    }

    if (sets.length === 0) return this.loadBed(companyId, bedId);
    await this.databaseService.query(
      `UPDATE print_beds SET ${sets.join(", ")} WHERE company_id = $1 AND bed_id = $2`,
      values
    );
    return this.loadBed(companyId, bedId);
  }

  // ──────────────────────────────────────────────────────────
  // POST /api/beds/:bedId/disassemble  — release child pieces back to
  // standalone scheduling. Sets the bed's status to 'disassembled' for
  // audit; we never physically delete a bed row.
  // ──────────────────────────────────────────────────────────
  async disassemble(
    companyId: string,
    bedId: string
  ): Promise<{ released: number; bed_deleted: boolean }> {
    const bed = await this.loadBed(companyId, bedId);
    if (bed.status === "scheduled" || bed.status === "printing") {
      throw new ConflictException(
        `Cannot disassemble a '${bed.status}' bed. Unschedule it first.`
      );
    }
    if (bed.status === "disassembled") {
      throw new ConflictException("Bed is already disassembled.");
    }
    // Only the keys of a plate that was actually removed, and only removed once
    // the transaction commits — a bucket delete cannot be rolled back.
    const fileKeys: string[] = [];
    const result = await this.databaseService.transaction(async (client) => {
      // Pieces return to 'pending', clean slate.
      const released = await client.query(
        `UPDATE order_pieces
            SET bed_id = NULL,
                status = 'pending'
          WHERE company_id = $1 AND bed_id = $2`,
        [companyId, bedId]
      );
      await client.query(
        `UPDATE print_beds
            SET status             = 'disassembled',
                assigned_printer_id      = NULL,
                assigned_nozzle_asset_id = NULL,
                scheduled_start_at = NULL,
                scheduled_end_at   = NULL,
                scheduled_at       = NULL
          WHERE company_id = $1 AND bed_id = $2`,
        [companyId, bedId]
      );
      // Every piece has just left, so the plate holds nothing. It used to be
      // left standing as an "archive" — but nothing can read that archive:
      // GET /beds excludes 'disassembled', so do the queue and the timeline,
      // and the only reference to a bed anywhere in the schema is the
      // order_pieces.bed_id this statement just cleared. So the row was
      // unreachable, not archived. A plate that genuinely RAN still keeps its
      // row (that is real history, and what recordOutcome leaves behind); one
      // that never ran is removed here, along with its own G-code and STL.
      const removal = await deleteEmptyBedTx(client, companyId, bedId, { keepIfItRan: true });
      fileKeys.push(...removal.keys);
      return { released: released.rowCount ?? 0, bed_deleted: removal.deleted };
    });
    // Committed — the plate is gone whatever happens next, so this never throws,
    // and it only removes keys nothing else still points at.
    await this.storage.removeUnreferenced(fileKeys);
    return result;
  }

  /** Readiness/scheduling is gated on slicer METADATA (print time + the
   *  quantity consumed) plus an assigned printer and, for FDM, a nozzle — never
   *  on the slicer file, which is an optional attachment the system never feeds
   *  to a printer.
   *
   *  The quantity is read in the PLATE'S OWN UNIT: grams of filament, or
   *  millilitres of resin. Written against grams alone — as it was — this
   *  answered "no data" for every resin plate forever, so a resin bed could
   *  never leave 'assigned'. Mirrors JobsService.hasSlicerCoreData and the
   *  client's hasPrintData; keep the three in step. */
  private hasSlicerCoreData(bed: {
    required_print_technology?: string | null;
    slicer_print_time_minutes: number | null;
    slicer_filament_used_grams: number | null;
    slicer_resin_used_ml?: number | null;
  }): boolean {
    if (bed.slicer_print_time_minutes == null) return false;
    return isResinTech(bed.required_print_technology)
      ? bed.slicer_resin_used_ml != null
      : bed.slicer_filament_used_grams != null;
  }

  /** Does this bed have everything its TECHNOLOGY needs to be schedulable?
   *  Filament: printer + nozzle + time + grams. Resin: printer + tank + time +
   *  millilitres. One predicate because restore() and reprint() each wrote the
   *  filament half by hand, so a resin plate coming back from cancelled or
   *  failed always landed on 'assigned' — sending the operator back through a
   *  print-data step for a plate that already had its numbers. */
  private isBedSchedulable(bed: BedRow): boolean {
    if (!bed.assigned_printer_id || !this.hasSlicerCoreData(bed)) return false;
    return isResinTech(bed.required_print_technology)
      ? !!bed.resin_tank_id
      : !!bed.assigned_nozzle_asset_id;
  }

  // ──────────────────────────────────────────────────────────
  // Status transitions — assign / schedule / unschedule / cancel /
  // complete — mirror the jobs.service equivalents 1:1. Kept here
  // so beds and pieces evolve in parallel; can refactor later to
  // share a common worker if we find the duplication painful.
  // ──────────────────────────────────────────────────────────
  async assign(
    companyId: string,
    bedId: string,
    input: {
      printer_id: string;
      /** Absent for resin — an MSLA/SLA machine has no nozzle to mount. */
      nozzle_asset_id?: string | null | undefined;
      slicer_print_time_minutes?: number | null | undefined;
      slicer_file_url?: string | null | undefined;
      stl_file_url?: string | null | undefined;
      slicer_filament_used_grams?: number | null | undefined;
      /** Resin's counterparts of nozzle + grams. */
      slicer_resin_used_ml?: number | null | undefined;
      resin_tank_id?: string | null | undefined;
    }
  ): Promise<BedRow> {
    const bed = await this.loadBed(companyId, bedId);
    if (bed.status !== "pending" && bed.status !== "assigned" && bed.status !== "ready") {
      throw new ConflictException(
        `Cannot assign a bed in status '${bed.status}'. Unschedule or restore it first.`
      );
    }
    const bedIsResin = isResinTech(bed.required_print_technology);
    // Printer compatibility is checked against the FILAMENT material, so FDM
    // needs one first. A resin plate has none — its material identity is the
    // tank — and demanding it here is what left every resin bed permanently
    // unassignable with an error naming a field it can never have.
    if (!bedIsResin && !bed.required_filament_material) {
      throw new BadRequestException(
        "Choose a filament material for this bed before assigning a printer — compatibility is checked against it."
      );
    }
    if (bedIsResin) {
      if (input.nozzle_asset_id) {
        throw new BadRequestException("A resin printer has no nozzle — omit nozzle_asset_id.");
      }
    } else {
      if (!input.nozzle_asset_id) {
        throw new BadRequestException("Choose a nozzle for this bed.");
      }
      const nozzleRes = await this.databaseService.query<{ exists: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM printer_nozzle_compatibility
            WHERE company_id = $1 AND printer_id = $2 AND nozzle_asset_id = $3
         ) AS exists`,
        [companyId, input.printer_id, input.nozzle_asset_id]
      );
      if (!nozzleRes.rows[0]?.exists) {
        throw new BadRequestException(
          "Selected nozzle is not compatible with the selected printer."
        );
      }
    }
    // A linked tank must be a real, usable resin tank in this company whose
    // formulation suits the plate's light source. Same validation the piece
    // path runs (JobsService.assign), so the two can't drift apart.
    if (input.resin_tank_id) {
      if (!bedIsResin) {
        throw new BadRequestException("Resin tanks only apply to MSLA/SLA beds.");
      }
      const tankRes = await this.databaseService.query<{ tech_compat: string }>(
        `SELECT COALESCE(resin_tech_compat, 'both') AS tech_compat
           FROM asset_instances
          WHERE company_id = $1 AND asset_id = $2 AND asset_type = 'resin_tank'
            AND split_at IS NULL`,
        [companyId, input.resin_tank_id]
      );
      const compat = tankRes.rows[0]?.tech_compat;
      if (!compat) {
        throw new BadRequestException(
          "Selected resin tank does not exist, or has been split into child tanks."
        );
      }
      const tech = (bed.required_print_technology ?? "").trim().toUpperCase();
      if (compat !== "both" && compat !== tech) {
        throw new BadRequestException(
          `That resin is formulated for ${compat} printers, but this bed is ${tech}.`
        );
      }
    }
    // Assumed metadata: when the payload doesn't state time/grams and the bed
    // doesn't have them yet, seed from the constituent pieces' quote numbers
    // (Σ cost_inputs.time / Σ cost_inputs.grams). A packed plate prints faster
    // than the pieces sequentially, so the sum is a safe over-estimate the
    // operator can trim — but it makes the bed schedulable in one step.
    let seedMinutes: number | null = null;
    let seedQuantity: number | null = null;
    // The quantity the plate consumes, in its own unit. For resin the quote's
    // quantity box IS millilitres (see BulkPieceEntry) — the same sum, landing
    // in the resin column instead of the gram one.
    const currentQuantity = bedIsResin ? bed.slicer_resin_used_ml : bed.slicer_filament_used_grams;
    const inputQuantity = bedIsResin ? input.slicer_resin_used_ml : input.slicer_filament_used_grams;
    const needsSeed =
      (input.slicer_print_time_minutes == null && bed.slicer_print_time_minutes == null) ||
      (inputQuantity == null && currentQuantity == null);
    if (needsSeed) {
      const quoteRes = await this.databaseService.query<{
        cost_inputs: { grams?: string[]; time?: string } | null;
      }>(
        `SELECT cost_inputs FROM order_pieces WHERE company_id = $1 AND bed_id = $2`,
        [companyId, bedId]
      );
      let minutesSum = 0;
      let quantitySum = 0;
      for (const r of quoteRes.rows) {
        const q = quoteAssumedMeta(r.cost_inputs);
        if (q.minutes != null) minutesSum += q.minutes;
        if (q.grams != null) quantitySum += q.grams;
      }
      seedMinutes = minutesSum > 0 ? Math.round(minutesSum) : null;
      seedQuantity = quantitySum > 0 ? Math.round(quantitySum * 100) / 100 : null;
    }
    // Seed the tank from the pieces already on the plate when the caller didn't
    // name one: those pieces were costed against a tank, and a plate pours from
    // one vat, so the first is the honest default. Without this the operator
    // would have to re-link a tank the plate already implies.
    let seedTankId: string | null = null;
    if (bedIsResin && !input.resin_tank_id && !bed.resin_tank_id) {
      const tankRes = await this.databaseService.query<{ resin_tank_id: string }>(
        `SELECT resin_tank_id FROM order_pieces
          WHERE company_id = $1 AND bed_id = $2 AND resin_tank_id IS NOT NULL
          LIMIT 1`,
        [companyId, bedId]
      );
      seedTankId = tankRes.rows[0]?.resin_tank_id ?? null;
    }
    await this.databaseService.query(
      `UPDATE print_beds
          SET assigned_printer_id        = $3,
              assigned_nozzle_asset_id   = $4,
              slicer_print_time_minutes  = COALESCE($5, slicer_print_time_minutes),
              slicer_file_url            = COALESCE($6, slicer_file_url),
              slicer_file_uploaded_at    = CASE WHEN $6 IS NOT NULL THEN now() ELSE slicer_file_uploaded_at END,
              slicer_filament_used_grams = COALESCE($7, slicer_filament_used_grams),
              stl_file_url               = COALESCE($8, stl_file_url),
              stl_file_uploaded_at       = CASE WHEN $8 IS NOT NULL THEN now() ELSE stl_file_uploaded_at END,
              slicer_resin_used_ml       = COALESCE($9, slicer_resin_used_ml),
              resin_tank_id              = COALESCE($10::uuid, resin_tank_id),
              -- Readiness in the plate's own unit, mirroring the piece path. The
              -- resin arm ALSO requires a tank: a volume with nothing to pour
              -- from is not a schedulable plate.
              status = CASE
                WHEN $11::boolean THEN
                  CASE WHEN COALESCE($5, slicer_print_time_minutes) IS NOT NULL
                        AND COALESCE($9, slicer_resin_used_ml) IS NOT NULL
                        AND COALESCE($10::uuid, resin_tank_id) IS NOT NULL
                       THEN 'ready' ELSE 'assigned' END
                WHEN COALESCE($5, slicer_print_time_minutes) IS NOT NULL
                 AND COALESCE($7, slicer_filament_used_grams) IS NOT NULL THEN 'ready'
                ELSE 'assigned'
              END
        WHERE company_id = $1 AND bed_id = $2`,
      [
        companyId, bedId,
        input.printer_id, input.nozzle_asset_id ?? null,
        input.slicer_print_time_minutes ?? seedMinutes,
        input.slicer_file_url ?? null,
        bedIsResin ? null : (input.slicer_filament_used_grams ?? seedQuantity),
        input.stl_file_url ?? null,
        bedIsResin ? (input.slicer_resin_used_ml ?? seedQuantity) : null,
        bedIsResin ? (input.resin_tank_id ?? seedTankId) : null,
        bedIsResin,
      ]
    );
    return this.loadBed(companyId, bedId);
  }

  // Swap the assigned nozzle in place (assigned/ready beds only). The nozzle
  // must come from the assigned printer's compatibility table.
  async setNozzle(companyId: string, bedId: string, nozzleAssetId: string): Promise<BedRow> {
    const bed = await this.loadBed(companyId, bedId);
    if (isResinTech(bed.required_print_technology)) {
      throw new BadRequestException("A resin printer has no nozzle to change.");
    }
    if (!bed.assigned_printer_id) {
      throw new ConflictException("Assign a printer before choosing a nozzle.");
    }
    // Assigned/ready swap freely. A SCHEDULED bed may also swap — the quick fix
    // when the chosen nozzle turns out to be busy — but only onto a nozzle
    // that's free during its committed window.
    if (bed.status !== "assigned" && bed.status !== "ready" && bed.status !== "scheduled") {
      throw new ConflictException(
        `The nozzle can only be changed on an 'assigned', 'ready' or 'scheduled' bed (current: '${bed.status}').`
      );
    }
    if (bed.status === "scheduled" && bed.scheduled_start_at && bed.scheduled_end_at) {
      const s = bed.scheduled_start_at;
      const e = bed.scheduled_end_at;
      const nzPiece = await this.databaseService.query<{ piece_name: string }>(
        `SELECT piece_name FROM order_pieces
          WHERE company_id = $1 AND assigned_nozzle_asset_id = $2
            AND status IN ('scheduled','printing')
            AND scheduled_start_at < $4 AND scheduled_end_at > $3
          LIMIT 1`,
        [companyId, nozzleAssetId, s, e]
      );
      if (nzPiece.rows[0]) {
        throw new ConflictException(
          `Can't switch — that nozzle is committed to "${nzPiece.rows[0].piece_name}" during this bed's window. Pick a free one.`
        );
      }
      const nzBed = await this.databaseService.query<{ bed_name: string }>(
        `SELECT bed_name FROM print_beds
          WHERE company_id = $1 AND assigned_nozzle_asset_id = $2 AND bed_id <> $3
            AND status IN ('scheduled','printing')
            AND scheduled_start_at < $5 AND scheduled_end_at > $4
          LIMIT 1`,
        [companyId, nozzleAssetId, bedId, s, e]
      );
      if (nzBed.rows[0]) {
        throw new ConflictException(
          `Can't switch — that nozzle is committed to bed "${nzBed.rows[0].bed_name}" during this bed's window. Pick a free one.`
        );
      }
    }
    const compat = await this.databaseService.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM printer_nozzle_compatibility
          WHERE company_id = $1 AND printer_id = $2 AND nozzle_asset_id = $3
       ) AS exists`,
      [companyId, bed.assigned_printer_id, nozzleAssetId]
    );
    if (!compat.rows[0]?.exists) {
      throw new BadRequestException(
        "Selected nozzle is not compatible with this bed's assigned printer."
      );
    }
    await this.databaseService.query(
      `UPDATE print_beds SET assigned_nozzle_asset_id = $3
        WHERE company_id = $1 AND bed_id = $2`,
      [companyId, bedId, nozzleAssetId]
    );
    return this.loadBed(companyId, bedId);
  }

  async schedule(
    companyId: string,
    bedId: string,
    input: { start_at: string }
  ): Promise<BedRow & { nozzle_switch?: NozzleSwitch }> {
    const bed = await this.loadBed(companyId, bedId);
    const bedIsResin = isResinTech(bed.required_print_technology);
    if (bed.status !== "ready" && bed.status !== "scheduled") {
      throw new ConflictException(
        `Cannot schedule a '${bed.status}' bed. Add slicer time + ${bedIsResin ? "resin volume" : "filament"} first.`
      );
    }
    if (bed.slicer_print_time_minutes == null) {
      throw new BadRequestException("Bed needs a slicer print time to schedule.");
    }
    if (!bed.assigned_printer_id) {
      throw new BadRequestException("Bed has no assigned printer.");
    }
    // Each technology's own material prerequisites. Asking a resin plate for
    // filament grams and a filament material — as this did unconditionally —
    // made every resin bed unschedulable behind an error about a material it
    // does not have.
    if (bedIsResin) {
      if (bed.slicer_resin_used_ml == null) {
        throw new BadRequestException(
          "Bed needs the resin volume this plate consumes (ml) to schedule."
        );
      }
      if (!bed.resin_tank_id) {
        throw new BadRequestException(
          "Link a resin tank to this bed before scheduling (a plate pours from one physical tank)."
        );
      }
    } else {
      if (bed.slicer_filament_used_grams == null) {
        throw new BadRequestException("Bed needs a slicer time and filament grams to schedule.");
      }
      // Filament optional until scheduling, then mandatory.
      if (!bed.required_filament_material) {
        throw new BadRequestException("Pick a filament material for the bed before scheduling.");
      }
    }
    const start = new Date(input.start_at);
    const end = new Date(start.getTime() + bed.slicer_print_time_minutes * 60_000);

    // Can't schedule a bed into the past (60s grace for clock skew / latency).
    if (start.getTime() < Date.now() - 60_000) {
      throw new BadRequestException(
        "Can't schedule a print in the past — pick a start time from now onward."
      );
    }

    // No double-booking the printer — check overlapping PIECES and other BEDS.
    const pieceOverlap = await this.databaseService.query<{ piece_id: string }>(
      `SELECT piece_id FROM order_pieces
        WHERE company_id = $1 AND assigned_printer_id = $2
          AND status IN ('scheduled','printing')
          AND scheduled_start_at < $4 AND scheduled_end_at > $3
        LIMIT 1`,
      [companyId, bed.assigned_printer_id, start.toISOString(), end.toISOString()]
    );
    if (pieceOverlap.rowCount && pieceOverlap.rowCount > 0) {
      throw new ConflictException("Time slot overlaps a piece already scheduled on this printer.");
    }
    const bedOverlap = await this.databaseService.query<{ bed_id: string }>(
      `SELECT bed_id FROM print_beds
        WHERE company_id = $1 AND assigned_printer_id = $2
          AND bed_id <> $3
          AND status IN ('scheduled','printing')
          AND scheduled_start_at < $5 AND scheduled_end_at > $4
        LIMIT 1`,
      [companyId, bed.assigned_printer_id, bedId, start.toISOString(), end.toISOString()]
    );
    if (bedOverlap.rowCount && bedOverlap.rowCount > 0) {
      throw new ConflictException("Time slot overlaps another bed on this printer.");
    }

    // The bed's reserved spool(s) — anchored on a child piece — are physical,
    // time-exclusive resources: reject if any is already feeding another
    // scheduled/printing piece or bed in this window. Without this, two prints
    // could be committed to the same physical spool at the same instant.
    const bedSpools = await this.databaseService.query<{ spool_asset_id: string }>(
      `SELECT DISTINCT ops.spool_asset_id
         FROM order_piece_spools ops
         JOIN order_pieces op ON op.piece_id = ops.piece_id
        WHERE ops.company_id = $1 AND op.bed_id = $2`,
      [companyId, bedId]
    );
    if (bedSpools.rowCount && bedSpools.rowCount > 0) {
      const spoolIds = bedSpools.rows.map((r) => r.spool_asset_id);
      const pieceSpool = await this.databaseService.query<{ piece_name: string }>(
        `SELECT op.piece_name
           FROM order_pieces op
           JOIN order_piece_spools ops ON ops.piece_id = op.piece_id
          WHERE op.company_id = $1
            AND ops.spool_asset_id = ANY($2::uuid[])
            AND op.status IN ('scheduled','printing')
            AND op.scheduled_start_at < $4 AND op.scheduled_end_at > $3
          LIMIT 1`,
        [companyId, spoolIds, start.toISOString(), end.toISOString()]
      );
      if (pieceSpool.rows[0]) {
        throw new ConflictException(
          `A reserved spool is already feeding "${pieceSpool.rows[0].piece_name}" in this time slot — a spool can't be on two printers at once.`
        );
      }
      const otherBedSpool = await this.databaseService.query<{ bed_name: string }>(
        `SELECT pb.bed_name
           FROM print_beds pb
           JOIN order_pieces op ON op.bed_id = pb.bed_id AND op.company_id = pb.company_id
           JOIN order_piece_spools ops ON ops.piece_id = op.piece_id
          WHERE pb.company_id = $1
            AND pb.bed_id <> $2
            AND ops.spool_asset_id = ANY($3::uuid[])
            AND pb.status IN ('scheduled','printing')
            AND pb.scheduled_start_at < $5 AND pb.scheduled_end_at > $4
          LIMIT 1`,
        [companyId, bedId, spoolIds, start.toISOString(), end.toISOString()]
      );
      if (otherBedSpool.rows[0]) {
        throw new ConflictException(
          `A reserved spool is already feeding bed "${otherBedSpool.rows[0].bed_name}" in this time slot — a spool can't be on two printers at once.`
        );
      }
    }

    // ── The tank is resin's spool: physically exclusive, and finite. Both
    //    checks mirror JobsService.schedule exactly, because the failure they
    //    prevent is the same one — committing two prints to a vat that can only
    //    hold one pour, or to a bottle that no longer has enough in it.
    if (bed.resin_tank_id) {
      const tankPiece = await this.databaseService.query<{ piece_name: string }>(
        `SELECT piece_name FROM order_pieces
          WHERE company_id = $1 AND resin_tank_id = $2
            AND bed_id IS DISTINCT FROM $3
            AND status IN ('scheduled','printing')
            AND scheduled_start_at < $5 AND scheduled_end_at > $4
          LIMIT 1`,
        [companyId, bed.resin_tank_id, bedId, start.toISOString(), end.toISOString()]
      );
      if (tankPiece.rows[0]) {
        throw new ConflictException(
          `That resin tank is already feeding "${tankPiece.rows[0].piece_name}" in this time slot — a tank can't be in two vats at once.`
        );
      }
      const tankBed = await this.databaseService.query<{ bed_name: string }>(
        `SELECT bed_name FROM print_beds
          WHERE company_id = $1 AND resin_tank_id = $2
            AND bed_id <> $3
            AND status IN ('scheduled','printing')
            AND scheduled_start_at < $5 AND scheduled_end_at > $4
          LIMIT 1`,
        [companyId, bed.resin_tank_id, bedId, start.toISOString(), end.toISOString()]
      );
      if (tankBed.rows[0]) {
        throw new ConflictException(
          `That resin tank is already feeding bed "${tankBed.rows[0].bed_name}" in this time slot — a tank can't be in two vats at once.`
        );
      }
      // Enough resin left, counting what is already promised to other prints.
      // The bed's OWN reservation is excluded so re-scheduling an already
      // committed plate doesn't read its own volume as someone else's claim.
      const tankStock = await this.databaseService.query<{ free_ml: string | null; label: string | null }>(
        `SELECT (COALESCE(ast.remaining_volume_ml, 0)
                 - COALESCE(ast.reserved_volume_ml, 0)
                 + CASE WHEN $3::text = 'scheduled' THEN COALESCE($4::numeric, 0) ELSE 0 END)::text AS free_ml,
                NULLIF(TRIM(CONCAT_WS(' ', ai.resin_brand, ai.resin_type, ai.resin_color)), '') AS label
           FROM asset_instances ai
           LEFT JOIN asset_stock ast ON ast.asset_id = ai.asset_id
          WHERE ai.company_id = $1 AND ai.asset_id = $2`,
        [companyId, bed.resin_tank_id, bed.status, bed.slicer_resin_used_ml]
      );
      const free = Number(tankStock.rows[0]?.free_ml ?? 0);
      const needed = Number(bed.slicer_resin_used_ml ?? 0);
      if (needed > free) {
        throw new BadRequestException(
          `${tankStock.rows[0]?.label ?? "That resin tank"} has ${Math.round(free)} ml free but this plate needs ${Math.round(needed)} ml.`
        );
      }
    }

    // The nozzle is its own resource — but WHICH of the printer's identical
    // 0.4mm brass nozzles serves the plate is a preference, not physics. Same
    // rule as a piece drop (JobsService.resolveNozzleForWindow, which is where
    // it is explained): a busy nozzle is swapped for a free twin of exactly the
    // same spec, and the placement is only refused when every twin is busy too.
    // A bed and a piece must agree here — the board drops both onto one lane,
    // and a bed that got rejected where a piece would have been placed is the
    // same board giving two answers.
    let nozzleSwitch: NozzleSwitch | null = null;
    if (bed.assigned_nozzle_asset_id && bed.assigned_printer_id) {
      const verdict = await this.jobsService.resolveNozzleForWindow(companyId, {
        printerId: bed.assigned_printer_id,
        nozzleAssetId: bed.assigned_nozzle_asset_id,
        startIso: start.toISOString(),
        endIso: end.toISOString(),
        excludeBedId: bedId,
      });
      if (!verdict.ok) {
        throw new ConflictException(`The assigned nozzle ${verdict.blockedBy}.`);
      }
      nozzleSwitch = verdict.switchTo;
    }

    // One statement for the swap and the commitment — see the same note in
    // JobsService.scheduleCommit.
    await this.databaseService.query(
      `UPDATE print_beds
          SET scheduled_start_at = $3,
              scheduled_end_at   = $4,
              scheduled_at       = now(),
              status             = 'scheduled',
              assigned_nozzle_asset_id = COALESCE($5::uuid, assigned_nozzle_asset_id)
        WHERE company_id = $1 AND bed_id = $2`,
      [companyId, bedId, start.toISOString(), end.toISOString(), nozzleSwitch?.to_nozzle_asset_id ?? null]
    );
    // Propagate scheduled status to child pieces so the order pages reflect
    // the bed's commitment.
    await this.propagatePieceStatus(companyId, bedId, "scheduled");
    const row = await this.loadBed(companyId, bedId);
    return nozzleSwitch ? { ...row, nozzle_switch: nozzleSwitch } : row;
  }

  async unschedule(companyId: string, bedId: string): Promise<BedRow> {
    const bed = await this.loadBed(companyId, bedId);
    if (bed.status !== "scheduled") {
      throw new ConflictException(`Only 'scheduled' beds can be unscheduled.`);
    }
    const target = this.hasSlicerCoreData(bed) ? "ready" : "assigned";
    await this.databaseService.query(
      `UPDATE print_beds
          SET scheduled_start_at = NULL, scheduled_end_at = NULL, scheduled_at = NULL,
              status = $3
        WHERE company_id = $1 AND bed_id = $2`,
      [companyId, bedId, target]
    );
    // Unscheduling frees the held filament — the spool is up for grabs again.
    await this.releaseSpools(companyId, bedId);
    await this.propagatePieceStatus(companyId, bedId, "pending");
    return this.loadBed(companyId, bedId);
  }

  async complete(
    companyId: string,
    bedId: string,
    input: { outcome: "done" | "failed"; actual_print_time_minutes?: number | undefined }
  ): Promise<BedRow> {
    const bed = await this.loadBed(companyId, bedId);
    if (bed.status !== "printing" && bed.status !== "scheduled") {
      throw new ConflictException(`Only printing/scheduled beds can be completed.`);
    }
    await this.databaseService.query(
      `UPDATE print_beds
          SET status                    = $3,
              print_started_at          = COALESCE(print_started_at, scheduled_start_at, now()),
              print_completed_at        = now(),
              actual_print_time_minutes = COALESCE($4, actual_print_time_minutes)
        WHERE company_id = $1 AND bed_id = $2`,
      [companyId, bedId, input.outcome, input.actual_print_time_minutes ?? null]
    );
    const bedIsResin = isResinTech(bed.required_print_technology);
    // Settle the reserved material in ITS OWN unit: a finished plate consumes it
    // (reserved → deducted from stock); a failed plate releases it so the
    // reprint can reserve afresh. A resin plate draws millilitres from its tank;
    // releasing is implicit for resin because the reservation is derived from
    // the bed's own status (see fn_recalc_reserved_volume_for_tank), which the
    // UPDATE above has already moved off 'scheduled'/'printing'.
    if (bedIsResin) {
      if (input.outcome === "done") {
        await this.databaseService.query(
          `UPDATE asset_stock ast
              SET remaining_volume_ml = GREATEST(0, COALESCE(ast.remaining_volume_ml, 0) - pb.slicer_resin_used_ml),
                  status = CASE
                             WHEN GREATEST(0, COALESCE(ast.remaining_volume_ml, 0) - pb.slicer_resin_used_ml) <= 0
                               THEN 'empty' ELSE ast.status
                           END
             FROM print_beds pb
            WHERE pb.company_id = $1
              AND pb.bed_id = $2
              AND pb.resin_tank_id = ast.asset_id
              AND pb.slicer_resin_used_ml IS NOT NULL`,
          [companyId, bedId]
        );
      }
    } else if (input.outcome === "done") {
      await this.databaseService.transaction(async (client) => {
        await this.consumeSpoolsTx(client, companyId, bedId);
      });
    } else {
      await this.releaseSpools(companyId, bedId);
    }
    // The plate's run is over, so the machine is free. Without this a plate
    // settled by hand leaves printer_stock.is_in_use TRUE against a finished
    // run — the clock only ever releases plates it completes itself. Same call
    // TimeStateService.completeDueBeds makes at this point in the lifecycle.
    if (bed.assigned_printer_id) {
      await releasePrinterTx(this.databaseService, companyId, bed.assigned_printer_id);
    }
    // Propagate to child pieces — operator can override individual pieces
    // separately via the order-pieces endpoints if some succeeded and
    // some failed in the same bed.
    await this.propagatePieceStatus(companyId, bedId, input.outcome);
    // A finished resin print is not a finished PART: it comes off the plate
    // coated in uncured resin and still has to be washed, then cured. The piece
    // path stamps this in JobsService.complete; without the same stamp here, a
    // resin PLATE's parts skipped the wash/cure queue entirely and went straight
    // to shippable — which is the one thing post_process_state exists to stop.
    // Only 'done' enters the queue; a failed run never does.
    if (bedIsResin && input.outcome === "done") {
      try {
        await this.databaseService.query(
          `UPDATE order_pieces
              SET post_process_state = 'print_done',
                  post_process_state_entered_at = now()
            WHERE company_id = $1 AND bed_id = $2
              AND status = 'done'
              AND post_process_state IS NULL`,
          [companyId, bedId]
        );
      } catch (e) {
        // Pre-migration column: the plate is still correctly 'done'.
        if ((e as { code?: string } | null)?.code !== "42703") throw e;
      }
    }
    return this.loadBed(companyId, bedId);
  }

  // ──────────────────────────────────────────────────────────
  // GET /api/beds/:bedId/outcome-plan — everything the triage console needs to
  // open, in one round trip.
  //
  // The only field here that is not already on the plate is `share`, and it is
  // the reason this endpoint exists rather than the console deriving what it
  // needs from GET /pieces. A piece's share of the plate's material is a MONEY
  // rule: it decides how much stock a good part consumes and what a failure is
  // pre-filled with. Deriving it a second time in the client — in another
  // language, with another rounding behaviour, in another repository that
  // cannot import this one — is exactly how two answers to one question start
  // disagreeing. So the server computes it with the same kernel the settle uses,
  // and the console only ever ADDS UP numbers it was handed.
  // ──────────────────────────────────────────────────────────
  async outcomePlan(companyId: string, bedId: string): Promise<BedOutcomePlan> {
    const bed = await this.loadBed(companyId, bedId);
    const bedIsResin = isResinTech(bed.required_print_technology);
    const plateQuantity = bedIsResin
      ? Number(bed.slicer_resin_used_ml ?? 0)
      : Number(bed.slicer_filament_used_grams ?? 0);

    const res = await this.databaseService.query<{
      piece_id: string;
      piece_name: string;
      order_id: string;
      order_number: string;
      order_title: string | null;
      customer_name: string | null;
      order_deadline: string | null;
      cost_inputs: { grams?: string[]; time?: string } | null;
    }>(
      `SELECT op.piece_id, op.piece_name, op.order_id, o.order_number,
              o.title AS order_title,
              COALESCE(
                NULLIF(cu.business_name, ''),
                NULLIF(TRIM(CONCAT_WS(' ', cu.first_name, cu.last_name)), '')
              ) AS customer_name,
              o.deadline::text AS order_deadline,
              op.cost_inputs
         FROM order_pieces op
         JOIN orders o ON o.order_id = op.order_id AND o.company_id = op.company_id
         LEFT JOIN customers cu ON cu.customer_id = o.customer_id
        WHERE op.company_id = $1 AND op.bed_id = $2
        ORDER BY COALESCE(NULLIF(TRIM(o.title), ''), o.order_number), op.piece_name, op.piece_id`,
      [companyId, bedId]
    );

    // Refuse to OPEN what cannot be committed. The settle caps the batch at the
    // same constant, and discovering that after triaging every row is the one
    // outcome worth spending a round trip to prevent.
    if (res.rows.length > MAX_PLATE_TRIAGE) {
      throw new BadRequestException(
        `This plate holds ${res.rows.length.toLocaleString()} pieces, more than the ` +
          `${MAX_PLATE_TRIAGE.toLocaleString()} that can be settled in one pass. ` +
          `Split the plate, or settle it with Mark done / Mark failed.`
      );
    }

    const shares = pieceShares(
      res.rows.map((p) => ({
        piece_id: p.piece_id,
        quoteQuantity: quoteAssumedMeta(p.cost_inputs).grams
      })),
      plateQuantity
    );

    return {
      bed_id: bed.bed_id,
      bed_name: bed.bed_name,
      status: bed.status,
      unit: bedIsResin ? "ml" : "g",
      is_resin: bedIsResin,
      plate_quantity: Math.round(plateQuantity * 100) / 100,
      // Whether 'assigned' is even offerable: without a printer to inherit, a
      // detached piece cannot hold that status (chk_assigned_requires_printer),
      // and the console must not present a choice the write will silently
      // downgrade.
      has_printer: bed.assigned_printer_id != null,
      printer_label: bed.assigned_printer_label,
      printer_technology: bed.assigned_printer_technology,
      printer_marker: bed.assigned_printer_marker,
      pieces: res.rows.map((p) => ({
        piece_id: p.piece_id,
        piece_name: p.piece_name,
        order_id: p.order_id,
        order_number: p.order_number,
        order_title: p.order_title,
        customer_name: p.customer_name,
        order_deadline: p.order_deadline,
        share: Math.round((shares.get(p.piece_id) ?? 0) * 100) / 100
      }))
    };
  }

  // ──────────────────────────────────────────────────────────
  // POST /api/beds/:bedId/outcome — triage a finished plate PIECE BY PIECE.
  //
  // NOTE ON FAILURE. Everything below happens in ONE transaction, so a plate
  // either settles completely or not at all — there is no half-triaged plate to
  // clean up. What the operator sees when it does not settle is handled by
  // asSettleFailure: a CHECK violation here means a piece was asked to hold a
  // state the database will not let it hold, and `new row for relation
  // "order_pieces" violates check constraint "chk_…"` on a shop floor is a
  // 500 with no next step in it.
  //
  // `complete()` above settles a plate as one thing: everything succeeded, or
  // everything failed. That is the truth for a small plate and a lie for a big
  // one. A plate of 300 parts routinely comes off with most of them good, a
  // handful warped or detached, and — when the run was stopped part-way — a
  // whole region that was never laid down at all. Forcing that into one verdict
  // meant either scrapping 288 good parts or quietly booking 12 failures as
  // successes, and then re-printing the whole plate to recover the difference.
  //
  // So this takes a verdict per piece and settles the three groups differently:
  //
  //   done        → the part is finished; its share of the plate's material is
  //                 deducted as ordinary consumption.
  //   failed      → the operator's MEASURED loss is deducted and booked to the
  //                 ledger as spoilage, and the piece goes back in the queue.
  //   not started → nothing is deducted, because nothing was ever extruded for
  //                 it, and the piece goes back in the queue.
  //
  // The arithmetic lives in ./outcome.ts, where it is proven on its own against
  // every shape of plate (see test/bed-outcome.test.ts) — this method is the
  // I/O around it: read the plate, settle the material, dismantle, re-queue.
  //
  // THE PLATE IS FULLY DISMANTLED. Every piece detaches, the good ones included:
  // the arrangement described one run, and that run is over. The good parts
  // continue as ordinary standalone pieces (they walk their own shipping
  // lifecycle through the order-pieces endpoints), and the rest go back to the
  // queue to be re-packed onto a new plate. The bed row itself survives as the
  // record of what the run achieved — status, timings, and the waste it caused —
  // and drops out of the working queue on its own, because every queue read
  // gates a plate on it still having pieces.
  //
  // Deliberately additive: `complete()` is untouched and still serves the
  // all-good and all-bad cases in one click.
  // ──────────────────────────────────────────────────────────
  async recordOutcome(
    companyId: string,
    userId: string | null,
    bedId: string,
    input: BedOutcomeInput
  ): Promise<BedOutcomeResult> {
    const bed = await this.loadBed(companyId, bedId);
    // Same gate as complete(): only a plate that is on (or committed to) a
    // machine has a run to report on.
    if (bed.status !== "printing" && bed.status !== "scheduled") {
      throw new ConflictException(
        `Only a printing or scheduled plate can be triaged (current: '${bed.status}').`
      );
    }

    const pieceRes = await this.databaseService.query<{
      piece_id: string;
      piece_name: string;
      order_id: string;
      order_number: string;
      cost_inputs: { grams?: string[]; time?: string } | null;
    }>(
      `SELECT op.piece_id, op.piece_name, op.order_id, o.order_number, op.cost_inputs
         FROM order_pieces op
         JOIN orders o ON o.order_id = op.order_id AND o.company_id = op.company_id
        WHERE op.company_id = $1 AND op.bed_id = $2
        ORDER BY op.piece_id`,
      [companyId, bedId]
    );
    const platePieces = pieceRes.rows;
    if (platePieces.length === 0) {
      throw new BadRequestException("This plate has no pieces left to triage.");
    }

    // Every id in the payload must be ON this plate. Fails CLOSED: a stray id is
    // refused outright rather than ignored, because the two ways it can arise —
    // a stale console whose plate changed underneath it, and a piece id from a
    // different plate — both mean the operator is looking at something other
    // than what they are about to settle.
    const onPlate = new Set(platePieces.map((p) => p.piece_id));
    const stray = input.pieces.filter((p) => !onPlate.has(p.piece_id));
    if (stray.length > 0) {
      throw new BadRequestException(
        `${stray.length} of the pieces submitted are not on this plate — reopen it and try again.`
      );
    }

    const bedIsResin = isResinTech(bed.required_print_technology);
    // The plate's planned draw, in ITS OWN unit. Both columns are exclusive by
    // construction (a plate is one technology), so reading the wrong one yields
    // a permanent null and would settle every plate as if it had cost nothing.
    const plateQuantity = bedIsResin
      ? Number(bed.slicer_resin_used_ml ?? 0)
      : Number(bed.slicer_filament_used_grams ?? 0);

    const settlement = settlePlate(
      platePieces.map((p) => ({
        piece_id: p.piece_id,
        // The piece's quote quantity is read in the plate's unit — the quote's
        // quantity box holds millilitres on a resin piece — which is exactly
        // why the same accessor serves both (see BedsService.assign's seeding).
        quoteQuantity: quoteAssumedMeta(p.cost_inputs).grams
      })),
      input.pieces,
      plateQuantity,
      // Resin waste is capped at what the job drew; filament waste is not.
      bedIsResin
    );

    // A plate that produced ANY good part is a plate that ran. Only a run that
    // yielded nothing at all is a failure of the plate as a whole.
    const bedOutcome: "done" | "failed" = settlement.doneCount > 0 ? "done" : "failed";

    const byOutcome = new Map(settlement.pieces.map((p) => [p.piece_id, p]));
    // Indexed rather than scanned: the failure loops below run once per failed
    // piece, and a linear `find` inside them turns a 300-piece plate into 90,000
    // comparisons for no reason.
    const pieceById = new Map(platePieces.map((p) => [p.piece_id, p]));
    const doneIds: string[] = [];
    const failedIds: string[] = [];
    const notStartedIds: string[] = [];
    for (const p of settlement.pieces) {
      if (p.outcome === "done") doneIds.push(p.piece_id);
      else if (p.outcome === "failed") failedIds.push(p.piece_id);
      else notStartedIds.push(p.piece_id);
    }

    // Where each re-queued group lands. `requeueStatus` downgrades 'assigned' to
    // 'pending' when there is no printer to inherit — detaching the piece
    // revokes the bed_id escape that let it sit statusless, and 'assigned'
    // without a printer is a CHECK violation, not a validation message.
    const failedTo = requeueStatus(input.failed_requeue_to, bed.assigned_printer_id);
    const notStartedTo = requeueStatus(input.not_started_requeue_to, bed.assigned_printer_id);

    const reason = (input.failure_reason ?? "").trim();
    const unitLabel = bedIsResin ? "ml" : "g";
    let bookedWaste = { quantity: 0, cost: 0 };

    await this.databaseService.transaction(async (client) => {
      const pieceIds = platePieces.map((p) => p.piece_id);

      // ── 0. Claim the plate ──────────────────────────────────────────────
      // Re-read the status under a row lock and re-assert it. The check at the
      // top of this method ran OUTSIDE any transaction, so two operators
      // triaging the same plate — or one double-clicking through a slow
      // response — can both pass it and both proceed to settle. That is not a
      // duplicated no-op: it deducts the material twice and posts the spoilage
      // to the ledger twice, and neither is visible afterwards without
      // reconciling the spool against the shelf.
      //
      // FOR UPDATE makes the second caller wait for the first to commit, at
      // which point the plate is no longer 'printing' and this throws instead.
      const claim = await client.query<{ status: string }>(
        `SELECT status FROM print_beds
          WHERE company_id = $1 AND bed_id = $2
          FOR UPDATE`,
        [companyId, bedId]
      );
      const claimed = claim.rows[0];
      if (!claimed) throw new NotFoundException("Bed not found.");
      if (claimed.status !== "printing" && claimed.status !== "scheduled") {
        throw new ConflictException(
          `This plate was already settled (it is now '${claimed.status}') — reopen it to see the outcome.`
        );
      }

      // ── 1. Settle the material ──────────────────────────────────────────
      // Order matters here and is not interchangeable: the reservation rows are
      // read before anything is written, the stock is moved while the pieces are
      // still attached, and the rows are deleted before any status changes. The
      // reservation is anchored on ONE child piece and `asset_stock.reserved_grams`
      // is recomputed by a trigger over those rows — detaching or re-statusing a
      // piece first would strand the reservation against stock that is no longer
      // going anywhere.
      if (bedIsResin) {
        if (bed.resin_tank_id && settlement.deduct > 0) {
          await client.query(
            `UPDATE asset_stock
                SET remaining_volume_ml = GREATEST(0, COALESCE(remaining_volume_ml, 0) - $2),
                    status = CASE
                               WHEN GREATEST(0, COALESCE(remaining_volume_ml, 0) - $2) <= 0
                                 THEN 'empty' ELSE status
                             END
              WHERE asset_id = $1`,
            [bed.resin_tank_id, settlement.deduct]
          );
        }
        if (bed.resin_tank_id && settlement.wasteTotal > 0) {
          const tankId = bed.resin_tank_id;
          bookedWaste = await this.finance.recordPlateWaste(client, companyId, userId, {
            unit: "ml",
            bedName: bed.bed_name,
            entries: failedIds.map((id) => ({
              pieceId: id,
              orderId: pieceById.get(id)!.order_id,
              assetId: tankId,
              quantity: byOutcome.get(id)?.waste ?? 0
            }))
          });
        }
      } else {
        const reserved = await client.query<{ spool_asset_id: string; planned_grams: string }>(
          `SELECT spool_asset_id, planned_grams
             FROM order_piece_spools
            WHERE company_id = $1 AND piece_id = ANY($2::uuid[])`,
          [companyId, pieceIds]
        );
        const spools = reserved.rows.map((r) => ({
          spoolAssetId: r.spool_asset_id,
          plannedGrams: Number(r.planned_grams)
        }));

        // What physically left the spools: the good parts' share plus every
        // measured loss. The remainder is simply never deducted — it is not a
        // second write, which is what makes it impossible for "consumed" and
        // "returned" to drift apart.
        for (const alloc of splitAcrossSpools(spools, settlement.deduct)) {
          await client.query(
            `UPDATE asset_stock
                SET remaining_grams = GREATEST(0, COALESCE(remaining_grams, 0) - $2),
                    status = CASE
                               WHEN GREATEST(0, COALESCE(remaining_grams, 0) - $2) <= 0
                                 THEN 'empty' ELSE status
                             END
              WHERE asset_id = $1`,
            [alloc.spoolAssetId, alloc.grams]
          );
        }

        if (settlement.wasteTotal > 0 && spools.length > 0) {
          // Each failed piece's loss, split across the plate's spools by the
          // same proportional rule the deduction used — so the ledger can never
          // charge a spool the stock update did not.
          const entries: {
            pieceId: string;
            orderId: string;
            assetId: string;
            quantity: number;
          }[] = [];
          for (const id of failedIds) {
            const waste = byOutcome.get(id)?.waste ?? 0;
            if (!(waste > 0)) continue;
            const orderId = pieceById.get(id)!.order_id;
            for (const alloc of splitAcrossSpools(spools, waste)) {
              entries.push({
                pieceId: id,
                orderId,
                assetId: alloc.spoolAssetId,
                quantity: alloc.grams
              });
            }
          }
          bookedWaste = await this.finance.recordPlateWaste(client, companyId, userId, {
            unit: "g",
            bedName: bed.bed_name,
            entries
          });
        }

        // Release what is left of the reservation. The plate is finished either
        // way: any material it did not consume goes back to being free stock,
        // not stock held against a run that has already happened.
        await client.query(
          `DELETE FROM order_piece_spools WHERE company_id = $1 AND piece_id = ANY($2::uuid[])`,
          [companyId, pieceIds]
        );
      }

      // ── 2. Close the plate ──────────────────────────────────────────────
      // Identical to complete()'s stamp, so a triaged plate and a completed one
      // carry the same evidence of when it ran and for how long.
      //
      // RETURNING, because the window this computes is not the plate's alone:
      // step 3 stamps the very same two instants onto every good part it
      // detaches. Reading them back is what makes the plate and its parts agree
      // to the microsecond — recomputing `now()` in the next statement would
      // put the parts a few milliseconds after the plate that made them, which
      // is the kind of difference that only ever shows up in a report.
      const closed = await client.query<{
        print_started_at: Date;
        print_completed_at: Date;
      }>(
        `UPDATE print_beds
            SET status                    = $3,
                -- LEAST(…, now()) because a plate can be settled from
                -- 'scheduled', and a scheduled window can still be in the
                -- future: without the clamp a plate triaged early records a run
                -- that finished before it started, and step 3 copies that onto
                -- every piece.
                print_started_at          = LEAST(
                                              COALESCE(print_started_at, scheduled_start_at, now()),
                                              now()
                                            ),
                print_completed_at        = now(),
                actual_print_time_minutes = COALESCE($4, actual_print_time_minutes)
          WHERE company_id = $1 AND bed_id = $2
        RETURNING print_started_at, print_completed_at`,
        [companyId, bedId, bedOutcome, input.actual_print_time_minutes ?? null]
      );
      const ranFrom = closed.rows[0]?.print_started_at ?? null;
      const ranTo = closed.rows[0]?.print_completed_at ?? null;

      // ── 3. Dismantle ────────────────────────────────────────────────────
      // Three set-based writes, one per destination — not a loop over pieces.
      // Each clears bed_id in the SAME statement that sets the status, so the
      // row is never momentarily a detached piece holding a status it cannot
      // satisfy.
      if (doneIds.length > 0) {
        // A good part carries out the WINDOW it was printed in, and nothing
        // else. Those two columns are what makes a finished piece exist:
        //
        //   · The database requires them. Every status constraint on
        //     order_pieces carries an `OR bed_id IS NOT NULL` escape, and this
        //     statement REVOKES that escape on the same line that sets the
        //     status — the exact shape of trap that already bit the resin work.
        //     A 'done' piece that leaves the plate without its completion stamp
        //     is a CHECK violation, and it surfaces as a bare 500 in the middle
        //     of settling a plate.
        //
        //   · Every report that counts finished work counts it by
        //     print_completed_at — the month's consumed-filament cost
        //     (FinanceReportsService.consumedFilamentThisMonth), throughput,
        //     material mix, the resin post-processing queue. A part with a NULL
        //     there is finished on screen and invisible in the accounts.
        //
        // What it deliberately does NOT carry out is the MACHINE: no printer,
        // no nozzle, no actual_print_time_minutes. The fleet's hours are summed
        // over standalone pieces (`bed_id IS NULL AND assigned_printer_id IS NOT
        // NULL`) UNION plates, so a plate whose parts came out holding its
        // printer and its six-hour run time would count those six hours once per
        // part. The plate's own row is where this run's machine time is recorded,
        // and it stays the only place.
        await client.query(
          `UPDATE order_pieces
              SET status             = 'done',
                  bed_id             = NULL,
                  print_started_at   = COALESCE($3::timestamptz, now()),
                  print_completed_at = COALESCE($4::timestamptz, now())
            WHERE company_id = $1 AND piece_id = ANY($2::uuid[])`,
          [companyId, doneIds, ranFrom, ranTo]
        );
      }

      // Re-queued pieces, grouped by where they land rather than by why they
      // got there: 'assigned' inherits the plate's machine and tooling so it can
      // be re-dropped straight onto it, 'pending' is a clean slate.
      const toAssigned = [
        ...(failedTo === "assigned" ? failedIds : []),
        ...(notStartedTo === "assigned" ? notStartedIds : [])
      ];
      const toPending = [
        ...(failedTo === "pending" ? failedIds : []),
        ...(notStartedTo === "pending" ? notStartedIds : [])
      ];

      if (toAssigned.length > 0) {
        await client.query(
          `UPDATE order_pieces
              SET bed_id                     = NULL,
                  status                     = 'assigned',
                  assigned_printer_id        = $3,
                  -- The plate's tooling, in the piece's own technology. A resin
                  -- piece must not inherit a nozzle (it has no hotend) and an
                  -- FDM piece must not inherit a tank; both columns are cleared
                  -- on the wrong side rather than left to a COALESCE, which is
                  -- what once kept a ghost nozzle on resin work forever.
                  assigned_nozzle_asset_id   = $4,
                  resin_tank_id              = $5,
                  scheduled_start_at         = NULL,
                  scheduled_end_at           = NULL,
                  scheduled_at               = NULL,
                  slicer_file_url            = NULL,
                  slicer_file_uploaded_at    = NULL,
                  slicer_print_time_minutes  = NULL,
                  slicer_filament_used_grams = NULL,
                  slicer_resin_used_ml       = NULL,
                  -- A piece going back in the queue has NOT been printed, and
                  -- has certainly not been shipped. These are the columns
                  -- JobsService.requeue, BedsService.reprint and bulkUnassign
                  -- all clear, and for the same reason: a stale
                  -- print_completed_at makes a piece sitting in the pending pool
                  -- count as finished work in every report that reads that
                  -- column, and a stale fulfilment_status lets the shipping
                  -- rollup carry on advancing a part that does not exist yet.
                  -- Cleared here rather than assumed absent, because a re-queued
                  -- piece can be triaged off a second plate.
                  print_started_at           = NULL,
                  print_completed_at         = NULL,
                  actual_print_time_minutes  = NULL,
                  actual_filament_used_grams = NULL,
                  fulfilment_status          = 'none'
            WHERE company_id = $1 AND piece_id = ANY($2::uuid[])`,
          [
            companyId,
            toAssigned,
            bed.assigned_printer_id,
            bedIsResin ? null : bed.assigned_nozzle_asset_id,
            bedIsResin ? bed.resin_tank_id : null
          ]
        );
      }

      if (toPending.length > 0) {
        // Byte-for-byte the clearing bulkUnassign performs, so a piece pulled
        // back from a plate is indistinguishable from one pulled back from a
        // printer — there is one definition of "back in the pending pool".
        await client.query(
          `UPDATE order_pieces
              SET bed_id                     = NULL,
                  status                     = 'pending',
                  assigned_printer_id        = NULL,
                  assigned_nozzle_asset_id   = NULL,
                  resin_tank_id              = NULL,
                  scheduled_start_at         = NULL,
                  scheduled_end_at           = NULL,
                  scheduled_at               = NULL,
                  slicer_file_url            = NULL,
                  slicer_file_uploaded_at    = NULL,
                  slicer_print_time_minutes  = NULL,
                  slicer_filament_used_grams = NULL,
                  slicer_resin_used_ml       = NULL,
                  -- Same run-stamp clearing as the 'assigned' branch above.
                  print_started_at           = NULL,
                  print_completed_at         = NULL,
                  actual_print_time_minutes  = NULL,
                  actual_filament_used_grams = NULL,
                  fulfilment_status          = 'none'
            WHERE company_id = $1 AND piece_id = ANY($2::uuid[])`,
          [companyId, toPending]
        );
      }

      // A finished resin print is not a finished PART — it comes off the plate
      // coated in uncured resin and still has to be washed and cured. Same stamp
      // complete() applies, and the same tolerance for the column not existing
      // yet: the parts are correctly 'done' either way.
      //
      // The re-queued parts move the OTHER way. A piece that failed or was never
      // laid down has nothing to wash, so if it is carrying a post-processing
      // state from an earlier run it has to give it up here — otherwise it sits
      // in the wash queue forever for a print that does not exist. Mirrors
      // JobsService.requeue, which clears the same pair.
      //
      // The CLEARING runs for ANY technology while the stamping is resin-only: a
      // re-queued piece can have arrived from a resin plate earlier in its life,
      // and gating the clear on THIS plate's technology would leave it in the
      // wash queue forever. Both statements sit inside one savepoint so a
      // pre-migration column is tolerated in exactly one place — and it has to
      // be a savepoint, because a failed statement poisons the whole
      // transaction and catching the error without one would take the next
      // query down with it.
      const requeuedIds = [...toAssigned, ...toPending];
      if ((bedIsResin && doneIds.length > 0) || requeuedIds.length > 0) {
        await client.query("SAVEPOINT bed_outcome_post_process");
        try {
          if (bedIsResin && doneIds.length > 0) {
            await client.query(
              `UPDATE order_pieces
                  SET post_process_state = 'print_done',
                      post_process_state_entered_at = now()
                WHERE company_id = $1 AND piece_id = ANY($2::uuid[])
                  AND status = 'done'
                  AND post_process_state IS NULL`,
              [companyId, doneIds]
            );
          }
          if (requeuedIds.length > 0) {
            await client.query(
              `UPDATE order_pieces
                  SET post_process_state = NULL,
                      post_process_state_entered_at = NULL
                WHERE company_id = $1 AND piece_id = ANY($2::uuid[])
                  AND post_process_state IS NOT NULL`,
              [companyId, requeuedIds]
            );
          }
          await client.query("RELEASE SAVEPOINT bed_outcome_post_process");
        } catch (e) {
          if ((e as { code?: string } | null)?.code !== "42703") throw e;
          await client.query("ROLLBACK TO SAVEPOINT bed_outcome_post_process");
        }
      }

      // ── 3b. Give the machine back ───────────────────────────────────────
      // A plate that is printing holds its printer's lock — by printer id, with
      // a NULL currently_printing_piece_id, because the lock belongs to the
      // plate and not to any one part of it. The clock releases that lock when a
      // plate's scheduled window elapses (TimeStateService.completeDueBeds); a
      // plate settled BY HAND before that moment never reaches the clock, and
      // the machine stays flagged in-use against a run that is over.
      if (bed.assigned_printer_id) {
        await releasePrinterTx(client, companyId, bed.assigned_printer_id);
      }

      // ── 4. Record what happened ─────────────────────────────────────────
      // Per-piece detail for the FAILURES only, because that is where a number
      // was recorded that nobody can reconstruct later — what was lost, and why.
      // A done or never-started piece is fully described by the plate's own
      // summary line, and writing three hundred of those per triage would bury
      // the entries that matter under the ones that do not.
      const events: OrderHistoryEvent[] = [];
      for (const id of failedIds) {
        const p = pieceById.get(id)!;
        const waste = byOutcome.get(id)?.waste ?? 0;
        events.push({
          entityType: "piece",
          eventType: "piece_failed",
          orderId: p.order_id,
          orderNumber: p.order_number,
          pieceId: p.piece_id,
          pieceName: p.piece_name,
          description:
            `Piece "${p.piece_name}" failed on plate "${bed.bed_name}" — ` +
            `${Math.round(waste)}${unitLabel} wasted, returned to ${failedTo}.` +
            (reason ? ` Reason: ${reason}` : "")
        });
      }

      // One summary per affected order. A plate can span several, and each
      // order's history should be able to explain its own pieces without the
      // reader having to find the plate.
      // Tallied in ONE pass over the plate rather than re-filtering it per
      // order: a plate spanning fifty orders would otherwise walk all three
      // hundred pieces fifty times over to produce fifty short sentences.
      type OrderTally = {
        orderNumber: string;
        done: number;
        failed: number;
        notStarted: number;
        lost: number;
      };
      const affectedOrders = new Map<string, OrderTally>();
      for (const p of platePieces) {
        let tally = affectedOrders.get(p.order_id);
        if (!tally) {
          tally = { orderNumber: p.order_number, done: 0, failed: 0, notStarted: 0, lost: 0 };
          affectedOrders.set(p.order_id, tally);
        }
        const settled = byOutcome.get(p.piece_id);
        if (settled?.outcome === "done") tally.done += 1;
        else if (settled?.outcome === "failed") {
          tally.failed += 1;
          tally.lost += settled.waste;
        } else tally.notStarted += 1;
      }
      for (const [orderId, t] of affectedOrders) {
        events.push({
          entityType: "order",
          eventType: "bed_outcome_recorded",
          orderId,
          orderNumber: t.orderNumber,
          description:
            `Plate "${bed.bed_name}" triaged — ${t.done} done, ${t.failed} failed, ` +
            `${t.notStarted} not started` +
            (t.lost > 0 ? ` (${Math.round(t.lost)}${unitLabel} wasted)` : "") +
            `. The plate was dismantled.`
        });
      }
      await recordOrderHistoryBatch(client, companyId, events);

      // Every touched order re-derives its own status: pieces moved in both
      // directions here, so an order can equally have just been completed or
      // just been pushed back into preparation.
      for (const orderId of affectedOrders.keys()) {
        await recomputeOrderStatusTx(client, companyId, orderId);
      }
    }).catch((e: unknown) => {
      throw asSettleFailure(e);
    });

    return {
      bed_id: bedId,
      bed_status: bedOutcome,
      done: settlement.doneCount,
      failed: settlement.failedCount,
      not_started: settlement.notStartedCount,
      failed_requeued_to: failedTo,
      not_started_requeued_to: notStartedTo,
      unit: unitLabel,
      // What the plate planned, what left stock, what was booked as spoilage,
      // and what stayed on the spool. Reported together so the console can show
      // the operator the whole settlement rather than just the part they typed.
      plate_quantity: Math.round(plateQuantity * 100) / 100,
      consumed: Math.round(settlement.deduct * 100) / 100,
      wasted: Math.round(settlement.wasteTotal * 100) / 100,
      returned_to_stock: Math.round(settlement.untouched * 100) / 100,
      waste_cost: Math.round(bookedWaste.cost * 100) / 100
    };
  }

  async cancel(companyId: string, bedId: string): Promise<BedRow> {
    const bed = await this.loadBed(companyId, bedId);
    if (bed.status === "done" || bed.status === "cancelled" || bed.status === "disassembled") {
      throw new ConflictException(`Bed already in terminal status '${bed.status}'.`);
    }
    await this.databaseService.query(
      `UPDATE print_beds
          SET status             = 'cancelled',
              scheduled_start_at = NULL,
              scheduled_end_at   = NULL,
              scheduled_at       = NULL
        WHERE company_id = $1 AND bed_id = $2`,
      [companyId, bedId]
    );
    // A cancelled bed won't print — give the reserved filament back.
    await this.releaseSpools(companyId, bedId);
    // Cancelled bed → child pieces also cancelled (they were going to be
    // part of this print; the operator must dismantle to make any change).
    await this.propagatePieceStatus(companyId, bedId, "cancelled");
    return this.loadBed(companyId, bedId);
  }

  // ──────────────────────────────────────────────────────────
  // POST /api/beds/:bedId/fulfilment — advance a DONE bed through its
  // shipping/fulfilment lifecycle (forward only). A bed has no fulfilment
  // column of its own: it walks the orthogonal `fulfilment_status` of EVERY
  // constituent done piece in lockstep. We validate `target` against the bed's
  // aggregate (least-advanced) stage, then move each done piece for which the
  // target is a valid next step — laggards catch up, leaders are left alone.
  // Affected orders are re-synced once each so their status mirrors shipping.
  // ──────────────────────────────────────────────────────────
  async transitionBedFulfilment(
    companyId: string,
    bedId: string,
    target: string
  ): Promise<BedRow> {
    const bed = await this.loadBed(companyId, bedId);

    if (bed.status !== "done") {
      throw new ConflictException(
        "Only a done bed can enter the shipping/fulfilment flow."
      );
    }

    const current = bed.fulfilment_status ?? "none";
    const allowed = BED_FULFILMENT_TRANSITIONS[current] ?? [];
    if (!allowed.includes(target)) {
      throw new BadRequestException(
        `A bed that is ${BED_FULFILMENT_LABELS[current] ?? current} cannot be marked ${BED_FULFILMENT_LABELS[target] ?? target}.`
      );
    }

    await this.databaseService.transaction(async (client) => {
      const pieces = await client.query<{
        piece_id: string;
        order_id: string;
        order_number: string;
        piece_name: string;
        fulfilment_status: string;
      }>(
        `SELECT op.piece_id, op.order_id, o.order_number, op.piece_name,
                COALESCE(op.fulfilment_status, 'none') AS fulfilment_status
           FROM order_pieces op
           JOIN orders o ON o.order_id = op.order_id
          WHERE op.company_id = $1 AND op.bed_id = $2 AND op.status = 'done'`,
        [companyId, bedId]
      );

      const affectedOrders = new Set<string>();
      for (const p of pieces.rows) {
        // Skip pieces already at/ahead of the target — only the laggards move.
        const pieceAllowed = BED_FULFILMENT_TRANSITIONS[p.fulfilment_status] ?? [];
        if (!pieceAllowed.includes(target)) continue;

        await client.query(
          `UPDATE order_pieces
              SET fulfilment_status = $3
            WHERE company_id = $1 AND piece_id = $2`,
          [companyId, p.piece_id, target]
        );
        await recordOrderHistory(client, companyId, {
          entityType: "piece",
          eventType: "fulfilment_changed",
          orderId: p.order_id,
          orderNumber: p.order_number,
          pieceId: p.piece_id,
          pieceName: p.piece_name,
          description: `Piece "${p.piece_name}" marked ${BED_FULFILMENT_LABELS[target] ?? target} (via bed "${bed.bed_name}").`
        });
        affectedOrders.add(p.order_id);
      }

      // Re-derive each touched order's status so it mirrors shipping progress.
      for (const orderId of affectedOrders) {
        await recomputeOrderStatusTx(client, companyId, orderId);
      }
    });

    return this.loadBed(companyId, bedId);
  }

  // ──────────────────────────────────────────────────────────
  // POST /api/beds/:bedId/post-process — walk a DONE resin bed through
  // wash → cure. Structurally identical to transitionBedFulfilment above and
  // for the same reason: a bed owns no post-process column, it walks the
  // orthogonal state of every constituent done piece in lockstep. Validated
  // against the bed's aggregate (least-advanced) stage, then applied to each
  // piece for which the target is a valid next step — laggards catch up,
  // leaders are left alone. No order re-sync: post-processing doesn't move the
  // order's status the way shipping does.
  // ──────────────────────────────────────────────────────────
  async transitionBedPostProcess(
    companyId: string,
    bedId: string,
    target: string
  ): Promise<BedRow> {
    const bed = await this.loadBed(companyId, bedId);

    if (bed.status !== "done") {
      throw new ConflictException("Only a done bed can be washed or cured.");
    }

    const current = bed.post_process_state;
    if (!current) {
      throw new BadRequestException(
        "This bed has no post-processing stage — only resin (MSLA/SLA) prints are washed and cured."
      );
    }

    const allowed = PIECE_POST_PROCESS_TRANSITIONS[current] ?? [];
    if (!allowed.includes(target)) {
      throw new BadRequestException(
        `A bed that is ${current.replace("_", " ")} cannot be marked ${target}.`
      );
    }

    await this.databaseService.transaction(async (client) => {
      const pieces = await client.query<{
        piece_id: string;
        order_id: string;
        order_number: string;
        piece_name: string;
        post_process_state: string;
      }>(
        `SELECT op.piece_id, op.order_id, o.order_number, op.piece_name, op.post_process_state
           FROM order_pieces op
           JOIN orders o ON o.order_id = op.order_id
          WHERE op.company_id = $1 AND op.bed_id = $2 AND op.status = 'done'
            AND op.post_process_state IS NOT NULL`,
        [companyId, bedId]
      );

      for (const p of pieces.rows) {
        const pieceAllowed = PIECE_POST_PROCESS_TRANSITIONS[p.post_process_state] ?? [];
        if (!pieceAllowed.includes(target)) continue;

        await client.query(
          `UPDATE order_pieces
              SET post_process_state            = $3,
                  post_process_state_entered_at = now()
            WHERE company_id = $1 AND piece_id = $2`,
          [companyId, p.piece_id, target]
        );
        await recordOrderHistory(client, companyId, {
          entityType: "piece",
          eventType: "post_process_changed",
          orderId: p.order_id,
          orderNumber: p.order_number,
          pieceId: p.piece_id,
          pieceName: p.piece_name,
          description: `Piece "${p.piece_name}" marked ${target} (via bed "${bed.bed_name}").`
        });
      }
    });

    return this.loadBed(companyId, bedId);
  }

  // ──────────────────────────────────────────────────────────
  // POST /api/beds/:bedId/restore — bring a cancelled bed back.
  // Restores to 'ready' if it still has printer+nozzle+slicer file,
  // else 'assigned' if it has a printer, else 'pending'. Child pieces
  // return to 'pending'. Always lands unscheduled.
  // ──────────────────────────────────────────────────────────
  // ──────────────────────────────────────────────────────────
  // DELETE /api/beds/:bedId — force-delete a bed and cascade-delete all of
  // its child pieces, regardless of status (the Jobs page "delete anything"
  // path). Reserved filament is returned to stock first; affected orders are
  // re-synced after the pieces vanish.
  // ──────────────────────────────────────────────────────────
  async deleteBed(companyId: string, bedId: string): Promise<{ deleted: true; bed_id: string }> {
    const bed = await this.loadBed(companyId, bedId); // 404 if it doesn't exist / wrong company
    // Removed after the transaction commits, and only the keys nothing else
    // still points at — a bed's pieces can be duplicates sharing one G-code.
    const fileKeys: string[] = [];
    await this.databaseService.transaction(async (client) => {
      // A bed that is actively printing holds its printer's lock (a bed's lock
      // has a NULL currently_printing_piece_id, so it's released by printer id,
      // not by piece). Free it before the bed + its pieces vanish, else the
      // machine stays is_in_use with a dangling reference.
      if (bed.status === "printing" && bed.assigned_printer_id) {
        await releasePrinterTx(client, companyId, bed.assigned_printer_id);
      }

      // `op.*` rather than a named list: the piece file columns each ship in
      // their own migration, so a field is present exactly when its column is.
      const pieceRes = await client.query<{ piece_id: string; order_id: string; slicer_file_url?: string | null; stl_file_url?: string | null; stl_thumbnail_url?: string | null }>(
        `SELECT op.* FROM order_pieces op WHERE op.company_id = $1 AND op.bed_id = $2`,
        [companyId, bedId]
      );
      // The plate's own files plus every child piece's, captured before the
      // rows carrying them are deleted below.
      fileKeys.push(...keysFromRows([bed as unknown as Record<string, unknown>], BED_FILE_FIELDS));
      fileKeys.push(...keysFromRows(pieceRes.rows, PIECE_FILE_FIELDS));
      // Release each child piece's spool reservations.
      for (const p of pieceRes.rows) {
        await releasePieceSpoolsTx(client, companyId, p.piece_id);
      }
      // Delete the child pieces, then the bed itself.
      await client.query(
        `DELETE FROM order_pieces WHERE company_id = $1 AND bed_id = $2`,
        [companyId, bedId]
      );
      await client.query(
        `DELETE FROM print_beds WHERE company_id = $1 AND bed_id = $2`,
        [companyId, bedId]
      );
      // Re-sync the orders those pieces belonged to.
      const orderIds = [...new Set(pieceRes.rows.map((r) => r.order_id))];
      for (const orderId of orderIds) {
        await recomputeOrderStatusTx(client, companyId, orderId);
      }
    });
    // Committed — the bed and its pieces are gone whatever happens next.
    await this.storage.removeUnreferenced(fileKeys);
    return { deleted: true, bed_id: bedId };
  }

  async restore(companyId: string, bedId: string): Promise<BedRow> {
    const bed = await this.loadBed(companyId, bedId);
    if (bed.status !== "cancelled" && bed.status !== "disassembled") {
      throw new ConflictException(
        `Only cancelled beds can be restored (current: '${bed.status}').`
      );
    }
    const target = this.isBedSchedulable(bed)
      ? "ready"
      : bed.assigned_printer_id
      ? "assigned"
      : "pending";
    await this.databaseService.query(
      `UPDATE print_beds
          SET status             = $3,
              scheduled_start_at = NULL,
              scheduled_end_at   = NULL,
              scheduled_at       = NULL
        WHERE company_id = $1 AND bed_id = $2`,
      [companyId, bedId, target]
    );
    await this.propagatePieceStatus(companyId, bedId, "pending");
    return this.loadBed(companyId, bedId);
  }

  // ──────────────────────────────────────────────────────────
  // POST /api/beds/:bedId/reprint — a failed bed is just up for
  // rescheduling again. Returns it to the normal schedulable state
  // ('ready' if it still has printer+nozzle+slicer file, else 'assigned',
  // else 'pending'), clearing the old schedule window + execution stamps so
  // the standard assign/schedule flow can run again. Child pieces follow the
  // bed's status (they're still physically on the bed).
  // ──────────────────────────────────────────────────────────
  async reprint(companyId: string, bedId: string): Promise<BedRow> {
    const bed = await this.loadBed(companyId, bedId);
    if (bed.status !== "failed") {
      throw new ConflictException(
        `Only failed beds can be re-queued for reprint (current: '${bed.status}').`
      );
    }
    const target = this.isBedSchedulable(bed)
      ? "ready"
      : bed.assigned_printer_id
      ? "assigned"
      : "pending";
    await this.databaseService.query(
      `UPDATE print_beds
          SET status                    = $3,
              scheduled_start_at        = NULL,
              scheduled_end_at          = NULL,
              scheduled_at              = NULL,
              print_started_at          = NULL,
              print_completed_at        = NULL,
              actual_print_time_minutes = NULL
        WHERE company_id = $1 AND bed_id = $2`,
      [companyId, bedId, target]
    );
    await this.databaseService.query(
      `UPDATE order_pieces
          SET scheduled_start_at        = NULL,
              scheduled_end_at          = NULL,
              scheduled_at              = NULL,
              print_started_at          = NULL,
              print_completed_at        = NULL,
              actual_print_time_minutes = NULL,
              actual_filament_used_grams = NULL
        WHERE company_id = $1 AND bed_id = $2`,
      [companyId, bedId]
    );
    await this.propagatePieceStatus(companyId, bedId, target);
    return this.loadBed(companyId, bedId);
  }
}
