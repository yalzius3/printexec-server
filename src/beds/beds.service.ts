import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { recordOrderHistory } from "../common/order-history";
import {
  quoteAssumedMeta,
  releasePieceSpoolsTx,
  recomputeOrderStatusTx,
  releasePrinterTx
} from "../common/cascade";
import { JobsService, isResinTech, materialFamily, type NozzleSwitch } from "../jobs/jobs.service";
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
  customer_names: string | null;
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

@Injectable()
export class BedsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly jobsService: JobsService
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
        ORDER BY o.order_number, op.piece_name`,
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
  async disassemble(companyId: string, bedId: string): Promise<{ released: number }> {
    const bed = await this.loadBed(companyId, bedId);
    if (bed.status === "scheduled" || bed.status === "printing") {
      throw new ConflictException(
        `Cannot disassemble a '${bed.status}' bed. Unschedule it first.`
      );
    }
    if (bed.status === "disassembled") {
      throw new ConflictException("Bed is already disassembled.");
    }
    return this.databaseService.transaction(async (client) => {
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
      return { released: released.rowCount ?? 0 };
    });
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
    await this.databaseService.transaction(async (client) => {
      // A bed that is actively printing holds its printer's lock (a bed's lock
      // has a NULL currently_printing_piece_id, so it's released by printer id,
      // not by piece). Free it before the bed + its pieces vanish, else the
      // machine stays is_in_use with a dangling reference.
      if (bed.status === "printing" && bed.assigned_printer_id) {
        await releasePrinterTx(client, companyId, bed.assigned_printer_id);
      }

      const pieceRes = await client.query<{ piece_id: string; order_id: string }>(
        `SELECT piece_id, order_id FROM order_pieces WHERE company_id = $1 AND bed_id = $2`,
        [companyId, bedId]
      );
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
