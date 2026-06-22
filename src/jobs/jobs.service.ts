import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { QueryResult, QueryResultRow } from "pg";
import { DatabaseService } from "../database/database.service";
import {
  reevaluateBedAfterPieceRemoval,
  recomputeOrderStatusTx,
  markPrinterPrintingTx,
  releasePrinterForPieceTx
} from "../common/cascade";
import type {
  AssignJobInput,
  CompleteJobInput,
  FindCandidatesInput,
  JobStatus,
  ListJobsQuery,
  ReserveSpoolsInput,
  RestoreJobInput,
  ScheduleJobInput,
  TimeHorizon,
  TimelineQuery,
  UpdatePieceFilesInput,
} from "./jobs.schemas";
import { JOB_STATUSES } from "./jobs.schemas";

// ────────────────────────────────────────────────────────────
// Material-family compatibility.
//
// Filament references carry specific variants ("ABS+", "PLA Matte",
// "Silk PLA", "PETG-CF", "TPU-95A", "PA12-CF"…) while printers list base
// families ("PLA", "ABS", "PETG", "TPU", "Nylon"…). A naive exact match
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
function materialsCompatible(filamentMaterial: string, printerMaterial: string): boolean {
  return materialFamily(filamentMaterial) === materialFamily(printerMaterial);
}

// Color matching for color slots vs. spools. Simple color names should match
// regardless of case ("Black" == "BLACK" == "black"), but distinct names stay
// distinct ("green" != "blue"). Trim + lowercase is enough for the free-text
// color field; operators who need finer distinction just type different names.
export function sameColor(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

// ────────────────────────────────────────────────────────────
// Row types — narrow shapes for the queries used below.
// ────────────────────────────────────────────────────────────
interface CompanyConfigRow {
  working_hours_start: string;
  working_hours_end: string;
  default_assignment_threshold_minutes: number;
}

interface ColorSlotRow {
  color_slot_id: string;
  sequence_order: number;
  slot_material: string;
  slot_color: string;
  slicer_grams: string | null;
}

interface JobRow {
  piece_id: string;
  order_id: string;
  order_reference: string;
  order_deadline: string;
  piece_name: string;
  description: string | null;
  status: JobStatus;
  assigned_printer_id: string | null;
  assigned_printer_label: string | null;
  assigned_nozzle_asset_id: string | null;
  required_print_technology: string | null;
  required_nozzle_diameter_mm: number | null;
  required_nozzle_material: string | null;
  required_filament_ref_id: string | null;
  required_filament_label: string | null;
  required_filament_material: string | null;
  // Single-colour pieces store their colour here (multicolour pieces carry it
  // per-slot in color_slots instead). Null for beds and legacy rows.
  required_color: string | null;
  required_multicolor_capable: boolean;
  requires_multicolor?: boolean;
  color_slots?: ColorSlotRow[] | null;
  slicer_print_time_minutes: number | null;
  slicer_filament_used_grams: number | null;
  slicer_file_url: string | null;
  // STL (or 3MF mesh) — source 3D model. Tracked independently from the
  // slicer file. Nullable until the operator uploads one.
  stl_file_url: string | null;
  scheduled_at: string | null;
  scheduled_start_at: string | null;
  scheduled_end_at: string | null;
  print_started_at: string | null;
  print_completed_at: string | null;
  created_at: string;
  last_updated_at: string;
  customer_name: string | null;
  // Per-piece price (NUMERIC → string). Optional: beds and some internal
  // JobRow builders don't carry it. Null when the piece isn't priced yet.
  cost?: string | null;
}

interface PrinterCandidateRow {
  printer_id: string;
  brand: string;
  model: string;
  serial_number: string | null;
  location: string | null;
  print_technology: string;
  build_volume_x_mm: number;
  build_volume_y_mm: number;
  build_volume_z_mm: number;
  is_multicolor: boolean;
  compatible_materials: string[] | null;
  is_in_use: boolean;
  is_under_maintenance: boolean;
  is_offline: boolean;
  committed_minutes: number;
}

interface NozzleCandidateRow {
  printer_id: string;
  nozzle_asset_id: string;
  nozzle_diameter_mm: number;
  nozzle_material: string | null;
  nozzle_status: string;
  next_free_at: string | null;
}

/**
 * Output shape for `/jobs/:pieceId/candidates`.
 * Each printer is reported with the stage at which it was eliminated (if any)
 * and the eligible nozzles surviving Stage 3+4. The UI uses both the survivors
 * and the eliminated set — the latter to show "why was this printer skipped?".
 *
 * `free_minutes_total` is the fragmented capacity (sum across the window),
 * `free_minutes_continuous` is the longest uninterrupted gap inside that
 * window — i.e. the largest block size the operator can actually schedule
 * without reshuffling.
 */
export interface CandidateResult {
  threshold_minutes: number;
  time_horizon: TimeHorizon;
  window_start: string;
  window_end: string;
  working_minutes_per_day: number;
  candidates: Array<{
    printer_id: string;
    brand: string;
    model: string;
    serial_number: string | null;
    location: string | null;
    free_minutes_total: number;
    free_minutes_continuous: number;
    // Build volume (mm) — surfaced so the operator can eyeball physical fit,
    // especially for beds where we DON'T know the model's footprint.
    build_volume_x_mm: number | null;
    build_volume_y_mm: number | null;
    build_volume_z_mm: number | null;
    // Soft material warning — the printer isn't listed for this filament, but
    // it still surfaces (operator override), mirroring the bed-fit caution.
    material_warning: string | null;
    eligible_nozzles: Array<{
      nozzle_asset_id: string;
      nozzle_diameter_mm: number;
      nozzle_material: string | null;
      next_free_at: string | null;
    }>;
  }>;
  eliminated: Array<{
    printer_id: string;
    brand: string;
    model: string;
    stage: 1 | 2 | 3 | 4;
    reason: string;
  }>;
}

@Injectable()
export class JobsService {
  constructor(private readonly databaseService: DatabaseService) {}

  // Whether the optional STL column exists. Cached with a short TTL so that
  // applying `db_add_order_piece_stl_file.sql` on a running server takes
  // effect within ~30 s instead of requiring a restart.
  private stlColumnAvailable: boolean | null = null;
  private stlCheckedAt = 0;
  private static readonly STL_CACHE_TTL_MS = 30_000;

  private async hasStlColumn(): Promise<boolean> {
    if (
      this.stlColumnAvailable !== null &&
      Date.now() - this.stlCheckedAt < JobsService.STL_CACHE_TTL_MS
    ) {
      return this.stlColumnAvailable;
    }
    const probe = await this.databaseService.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM information_schema.columns
          WHERE table_name = 'order_pieces' AND column_name = 'stl_file_url'
       ) AS exists`
    );
    this.stlColumnAvailable = !!probe.rows[0]?.exists;
    this.stlCheckedAt = Date.now();
    return this.stlColumnAvailable;
  }

  /** Force the next hasStlColumn() to round-trip — used after a write that
   *  hit a "column does not exist" race so the next request picks up the
   *  newly-applied migration without waiting for the TTL. */
  private invalidateStlCache() {
    this.stlColumnAvailable = null;
    this.stlCheckedAt = 0;
  }

  // Same TTL-cache pattern for the bed_id column. Added in
  // `db_add_print_beds.sql`; until that migration runs we silently skip
  // the bedded-piece filter so the workspace stays usable.
  private bedColumnAvailable: boolean | null = null;
  private bedCheckedAt = 0;
  private async hasBedColumn(): Promise<boolean> {
    if (
      this.bedColumnAvailable !== null &&
      Date.now() - this.bedCheckedAt < JobsService.STL_CACHE_TTL_MS
    ) {
      return this.bedColumnAvailable;
    }
    const probe = await this.databaseService.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM information_schema.columns
          WHERE table_name = 'order_pieces' AND column_name = 'bed_id'
       ) AS exists`
    );
    this.bedColumnAvailable = !!probe.rows[0]?.exists;
    this.bedCheckedAt = Date.now();
    return this.bedColumnAvailable;
  }

  // Whether the print_beds table exists (db_add_print_beds.sql applied).
  // Cached with the same TTL as the column checks.
  private bedsTableAvailable: boolean | null = null;
  private bedsTableCheckedAt = 0;
  private async hasBedsTable(): Promise<boolean> {
    if (
      this.bedsTableAvailable !== null &&
      Date.now() - this.bedsTableCheckedAt < JobsService.STL_CACHE_TTL_MS
    ) {
      return this.bedsTableAvailable;
    }
    const probe = await this.databaseService.query<{ reg: string | null }>(
      `SELECT to_regclass('public.print_beds')::text AS reg`
    );
    this.bedsTableAvailable = !!probe.rows[0]?.reg;
    this.bedsTableCheckedAt = Date.now();
    return this.bedsTableAvailable;
  }

  // ──────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────

  /** Convert a `HH:MM:SS` time string to minutes since midnight. */
  private timeToMinutes(t: string): number {
    const [h, m] = t.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  }

  private async getCompanyConfig(companyId: string): Promise<CompanyConfigRow> {
    // Defaults — used both as fallback when the columns aren't migrated yet,
    // and as the literal value baked into the SQL on the happy path. Keeps
    // the Jobs workspace usable even before the operator runs
    // `db_jobs_working_hours.sql` in Supabase.
    const DEFAULTS: CompanyConfigRow = {
      working_hours_start: "09:00:00",
      working_hours_end:   "21:00:00",
      default_assignment_threshold_minutes: 10,
    };
    try {
      const result = await this.databaseService.query<CompanyConfigRow>(
        `SELECT working_hours_start::text AS working_hours_start,
                working_hours_end::text   AS working_hours_end,
                default_assignment_threshold_minutes
           FROM companies
          WHERE company_id = $1`,
        [companyId]
      );
      if (result.rowCount === 0) {
        throw new NotFoundException("Company not found.");
      }
      return result.rows[0]!;
    } catch (e) {
      // Postgres "undefined_column" SQLSTATE = 42703 — happens when the
      // working_hours migration hasn't been applied yet. Fall back silently;
      // the workspace stays functional with sensible defaults.
      const code = (e as { code?: string } | null)?.code;
      if (code === "42703") {
        // Verify company exists before returning defaults — preserve the 404.
        const probe = await this.databaseService.query<{ exists: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM companies WHERE company_id = $1) AS exists`,
          [companyId]
        );
        if (!probe.rows[0]?.exists) {
          throw new NotFoundException("Company not found.");
        }
        return DEFAULTS;
      }
      throw e;
    }
  }

  /** Working minutes per day, computed from the company's operating window. */
  private workingMinutesPerDay(cfg: CompanyConfigRow): number {
    return Math.max(
      0,
      this.timeToMinutes(cfg.working_hours_end) -
        this.timeToMinutes(cfg.working_hours_start)
    );
  }

  /** Local-midnight today as a Date. */
  private todayStart(): Date {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return t;
  }

  /** Parse a `YYYY-MM-DD` date column to local-midnight Date. */
  private parseDateOnly(date: string): Date | null {
    const [y, m, d] = date.split("-").map(Number);
    if (!y || !m || !d) return null;
    const out = new Date(y, m - 1, d);
    out.setHours(0, 0, 0, 0);
    return out;
  }

  /**
   * Resolve the [window_start, window_end] interval that the capacity check
   * inspects. window_end is always local midnight (inclusive of the whole
   * last day) — this matches operator intuition: "deadline = Sep 9" means
   * "any time on Sep 9 is still valid".
   */
  private resolveWindow(horizon: TimeHorizon, deadline: string): { start: Date; end: Date } {
    const start = this.todayStart();
    let end: Date;
    if (horizon === "day") {
      end = new Date(start);
      end.setDate(end.getDate() + 1);
    } else if (horizon === "week") {
      end = new Date(start);
      end.setDate(end.getDate() + 7);
    } else if (horizon === "month") {
      end = new Date(start);
      end.setDate(end.getDate() + 30);
    } else {
      // "deadline" — end at midnight AT THE END of the deadline day.
      const due = this.parseDateOnly(deadline) ?? start;
      end = new Date(due);
      end.setDate(end.getDate() + 1);
    }
    if (end.getTime() < start.getTime()) end = new Date(start);
    return { start, end };
  }

  /**
   * Compute the working-time intervals (start, end as ms timestamps) inside
   * `[windowStart, windowEnd)`, given the company's daily working window.
   * The result is a list of disjoint ascending intervals — one per calendar
   * day touched by the window.
   */
  private workingIntervalsInWindow(
    windowStart: Date,
    windowEnd: Date,
    cfg: CompanyConfigRow
  ): Array<{ start: number; end: number }> {
    const out: Array<{ start: number; end: number }> = [];
    const dayStartMin = this.timeToMinutes(cfg.working_hours_start);
    const dayEndMin = this.timeToMinutes(cfg.working_hours_end);
    if (dayEndMin <= dayStartMin) return out;
    const cursor = new Date(windowStart);
    cursor.setHours(0, 0, 0, 0);
    while (cursor.getTime() < windowEnd.getTime()) {
      const dayOpen = new Date(cursor);
      dayOpen.setMinutes(dayStartMin);
      const dayClose = new Date(cursor);
      dayClose.setMinutes(dayEndMin);
      const segStart = Math.max(dayOpen.getTime(), windowStart.getTime(), Date.now());
      const segEnd = Math.min(dayClose.getTime(), windowEnd.getTime());
      if (segEnd > segStart) out.push({ start: segStart, end: segEnd });
      cursor.setDate(cursor.getDate() + 1);
    }
    return out;
  }

  /**
   * Subtract a list of `busy` intervals from `working` intervals, returning
   * the free segments inside the working window. Both inputs must be
   * ascending and disjoint.
   */
  private subtractBusy(
    working: Array<{ start: number; end: number }>,
    busy: Array<{ start: number; end: number }>
  ): Array<{ start: number; end: number }> {
    const free: Array<{ start: number; end: number }> = [];
    for (const w of working) {
      let segStart = w.start;
      for (const b of busy) {
        if (b.end <= segStart) continue;
        if (b.start >= w.end) break;
        if (b.start > segStart) {
          free.push({ start: segStart, end: Math.min(b.start, w.end) });
        }
        segStart = Math.max(segStart, b.end);
        if (segStart >= w.end) break;
      }
      if (segStart < w.end) free.push({ start: segStart, end: w.end });
    }
    return free;
  }

  /** Load a piece row (or throw 404) with parent order/customer fields. */
  private async loadJob(companyId: string, pieceId: string): Promise<JobRow> {
    const hasStl = await this.hasStlColumn();
    const result = await this.databaseService.query<JobRow>(
      this.jobSelectSql(hasStl, "WHERE op.company_id = $1 AND op.piece_id = $2"),
      [companyId, pieceId]
    );
    if (result.rowCount === 0) {
      throw new NotFoundException("Piece not found.");
    }
    return result.rows[0]!;
  }

  /**
   * Shared SELECT clause for piece+order+customer joins.
   * Centralising the SELECT keeps row-shape changes in one place — the queue
   * list, single-row read, and timeline all use this.
   */
  /**
   * Shared SELECT — `stl_file_url` is only projected when the migration
   * `db_add_order_piece_stl_file.sql` has been applied. Otherwise we project
   * NULL under the same alias so consumers can treat the field uniformly.
   */
  private jobSelectSql(
    hasStl: boolean,
    whereClause: string,
    orderBy = "op.created_at DESC",
    excludeDraftOrders = false
  ): string {
    const stlProjection = hasStl ? "op.stl_file_url" : "NULL::text AS stl_file_url";
    const orderStatusClause = excludeDraftOrders
      ? `AND o.status IN ('confirmed','in_progress','completed')`
      : "";
    return `
      SELECT
        op.piece_id,
        op.order_id,
        o.order_number AS order_reference,
        o.deadline::text AS order_deadline,
        op.piece_name,
        op.description,
        op.status,
        op.assigned_printer_id,
        CASE
          WHEN pi.printer_id IS NOT NULL THEN pi.brand || ' ' || pi.model
          ELSE NULL
        END AS assigned_printer_label,
        op.assigned_nozzle_asset_id,
        op.required_print_technology,
        op.required_nozzle_diameter_mm,
        op.required_nozzle_material,
        op.required_filament_ref_id,
        op.required_filament_material,
        CASE
          WHEN fr.filament_ref_id IS NOT NULL
            THEN fr.brand || ' ' || fr.material_type || ' (' || fr.color || ')'
          ELSE NULL
        END AS required_filament_label,
        op.required_color,
        op.required_multicolor_capable,
        op.requires_multicolor,
        (
          SELECT COALESCE(
            json_agg(
              json_build_object(
                'color_slot_id', cs.color_slot_id,
                'sequence_order', cs.sequence_order,
                'slot_material', cs.slot_material,
                'slot_color', cs.slot_color,
                'slicer_grams', cs.slicer_grams
              )
              ORDER BY cs.sequence_order
            ),
            '[]'::json
          )
          FROM order_piece_color_slots cs
          WHERE cs.piece_id = op.piece_id
        ) AS color_slots,
        op.slicer_print_time_minutes,
        op.slicer_filament_used_grams,
        op.slicer_file_url,
        op.cost,
        ${stlProjection},
        op.scheduled_at,
        op.scheduled_start_at,
        op.scheduled_end_at,
        op.print_started_at,
        op.print_completed_at,
        op.created_at,
        op.last_updated_at,
        -- B2B customers use business_name; B2C use first + last. Prefer business_name
        -- when present, fall back to a trimmed concat for individuals.
        COALESCE(
          NULLIF(cu.business_name, ''),
          NULLIF(TRIM(CONCAT_WS(' ', cu.first_name, cu.last_name)), '')
        ) AS customer_name
      FROM order_pieces op
      JOIN orders o            ON o.order_id = op.order_id AND o.company_id = op.company_id
      LEFT JOIN customers cu   ON cu.customer_id = o.customer_id
      LEFT JOIN printer_instances pi  ON pi.printer_id = op.assigned_printer_id
      LEFT JOIN filament_reference fr ON fr.filament_ref_id = op.required_filament_ref_id
      ${whereClause}
      ${orderStatusClause}
      ORDER BY ${orderBy}
    `;
  }

  // ──────────────────────────────────────────────────────────
  // GET /api/jobs/queue
  // ──────────────────────────────────────────────────────────
  async listJobs(companyId: string, query: ListJobsQuery): Promise<JobRow[]> {
    const values: unknown[] = [companyId];
    const wheres: string[] = ["op.company_id = $1"];

    if (query.status) {
      const list = String(query.status)
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is JobStatus => (JOB_STATUSES as readonly string[]).includes(s));
      if (list.length > 0) {
        values.push(list);
        wheres.push(`op.status = ANY($${values.length}::text[])`);
      }
    }
    if (query.order_id) {
      values.push(query.order_id);
      wheres.push(`op.order_id = $${values.length}`);
    }
    if (query.printer_id) {
      values.push(query.printer_id);
      wheres.push(`op.assigned_printer_id = $${values.length}`);
    }
    if (query.search) {
      values.push(`%${query.search.toLowerCase()}%`);
      wheres.push(
        `(LOWER(op.piece_name) LIKE $${values.length} OR LOWER(o.order_number) LIKE $${values.length})`
      );
    }

    const hasStl = await this.hasStlColumn();
    // Pieces that are part of a bed are hidden — the bed itself shows in
    // their place at the queue level. We only add this filter once the
    // `bed_id` column exists; otherwise we'd break the queue for users
    // who haven't run the print_beds migration yet.
    if (await this.hasBedColumn()) {
      wheres.push(`op.bed_id IS NULL`);
    }
    const sql = this.jobSelectSql(hasStl, `WHERE ${wheres.join(" AND ")}`, "op.created_at DESC", true);
    const result = await this.databaseService.query<JobRow>(sql, values);
    return result.rows;
  }

  async getJob(companyId: string, pieceId: string): Promise<JobRow> {
    return this.loadJob(companyId, pieceId);
  }

  // ──────────────────────────────────────────────────────────
  // POST /api/jobs/:pieceId/candidates
  // The 4-stage filter from the design memo.
  // ──────────────────────────────────────────────────────────
  async findCandidates(
    companyId: string,
    pieceId: string,
    input: FindCandidatesInput
  ): Promise<CandidateResult> {
    const piece = await this.loadJob(companyId, pieceId);
    // Multicolor pieces must satisfy every color slot's material (each is a
    // soft Stage-2 check); single-color pieces fall back to the one material.
    const slotMaterials = await this.listColorSlotMaterials(companyId, pieceId);
    return this.findCandidatesCore(
      companyId,
      {
        deadline: piece.order_deadline,
        technology: piece.required_print_technology,
        material: piece.required_filament_material,
        materials: slotMaterials.length > 0 ? slotMaterials : null,
        nozzleDiameterMm: piece.required_nozzle_diameter_mm,
        nozzleMaterial: piece.required_nozzle_material,
        // A piece that needs multiple colors inherently needs a multicolor-
        // capable printer — treat requires_multicolor as implying the hard gate,
        // independent of the standalone capability flag.
        multicolor: piece.required_multicolor_capable || (piece.requires_multicolor ?? false),
        excludePieceId: pieceId,
      },
      input
    );
  }

  /**
   * Shared 4-stage candidate filter, decoupled from order_pieces so beds (or
   * any future job-like entity) can reuse it. `req` carries the requirements;
   * `excludePieceId` is removed from the unscheduled-committed capacity count.
   */
  async findCandidatesCore(
    companyId: string,
    req: {
      deadline: string;
      technology: string | null;
      material: string | null;
      // Multicolor pieces require N distinct materials (one per color slot).
      // When present this supersedes `material` for the Stage 2 soft check.
      materials?: string[] | null;
      nozzleDiameterMm: number | null;
      nozzleMaterial: string | null;
      multicolor: boolean;
      excludePieceId: string | null;
    },
    input: FindCandidatesInput
  ): Promise<CandidateResult> {
    const cfg = await this.getCompanyConfig(companyId);
    const threshold = input.threshold_minutes ?? cfg.default_assignment_threshold_minutes;
    const horizon = input.time_horizon ?? "deadline";
    const window = this.resolveWindow(horizon, req.deadline);
    const workingMinutesPerDay = this.workingMinutesPerDay(cfg);
    const workingIntervals = this.workingIntervalsInWindow(window.start, window.end, cfg);

    // ── Pull every printer (basic spec + stock state). Per-printer busy
    //    intervals are joined in a second query so we can compute precise
    //    fragmented + continuous free time in JS.
    const printerSql = `
      SELECT
        pi.printer_id,
        pi.brand,
        pi.model,
        pi.serial_number,
        pi.location,
        pi.print_technology,
        pi.build_volume_x_mm,
        pi.build_volume_y_mm,
        pi.build_volume_z_mm,
        pi.is_multicolor,
        pi.compatible_materials,
        COALESCE(ps.is_in_use, FALSE)            AS is_in_use,
        COALESCE(ps.is_under_maintenance, FALSE) AS is_under_maintenance,
        COALESCE(ps.is_offline, FALSE)           AS is_offline,
        0 AS committed_minutes
      FROM printer_instances pi
      LEFT JOIN printer_stock ps ON ps.printer_id = pi.printer_id
      WHERE pi.company_id = $1
    `;

    const printersResult = await this.databaseService.query<PrinterCandidateRow>(
      printerSql,
      [companyId]
    );

    // ── Pull every scheduled/printing block in this window for any owned
    //    printer. The "busy" set used for free-time math.
    // Busy = scheduled/printing PIECES *and* BEDS on each printer. A bed
    // occupies its printer exactly like a piece, so it must reduce free time
    // and block overlaps. Beds may not be migrated yet — guard with a
    // to_regclass check so this query degrades to pieces-only otherwise.
    const hasBeds = await this.hasBedsTable();
    const busySql = `
      SELECT op.assigned_printer_id AS printer_id,
             op.scheduled_start_at  AS start_at,
             op.scheduled_end_at    AS end_at,
             COALESCE(op.slicer_print_time_minutes, 0) AS minutes
        FROM order_pieces op
       WHERE op.company_id = $1
         AND op.assigned_printer_id IS NOT NULL
         AND op.status IN ('scheduled','printing')
         AND op.scheduled_end_at   > $2::timestamptz
         AND op.scheduled_start_at < $3::timestamptz
      ${hasBeds ? `
      UNION ALL
      SELECT pb.assigned_printer_id AS printer_id,
             pb.scheduled_start_at  AS start_at,
             pb.scheduled_end_at    AS end_at,
             COALESCE(pb.slicer_print_time_minutes, 0) AS minutes
        FROM print_beds pb
       WHERE pb.company_id = $1
         AND pb.assigned_printer_id IS NOT NULL
         AND pb.status IN ('scheduled','printing')
         AND pb.scheduled_end_at   > $2::timestamptz
         AND pb.scheduled_start_at < $3::timestamptz
      ` : ``}
    `;
    const busyResult = await this.databaseService.query<{
      printer_id: string;
      start_at: string;
      end_at: string;
      minutes: number;
    }>(busySql, [companyId, window.start.toISOString(), window.end.toISOString()]);

    // Group busy intervals by printer (ascending start).
    const busyByPrinter = new Map<string, Array<{ start: number; end: number }>>();
    for (const b of busyResult.rows) {
      const arr = busyByPrinter.get(b.printer_id) ?? [];
      arr.push({
        start: new Date(b.start_at).getTime(),
        end: new Date(b.end_at).getTime(),
      });
      busyByPrinter.set(b.printer_id, arr);
    }
    for (const arr of busyByPrinter.values()) arr.sort((a, b) => a.start - b.start);

    // ── Nozzle busy intervals. A nozzle is an independent resource that can be
    //    mounted on different printers over time, so its bookings span ALL
    //    printers — gathered separately so Stage 4 can intersect the printer's
    //    free time with the nozzle's free time.
    const nozzleBusySql = `
      SELECT op.assigned_nozzle_asset_id AS nozzle_id,
             op.scheduled_start_at AS start_at,
             op.scheduled_end_at   AS end_at
        FROM order_pieces op
       WHERE op.company_id = $1
         AND op.assigned_nozzle_asset_id IS NOT NULL
         AND op.status IN ('scheduled','printing')
         AND op.scheduled_end_at   > $2::timestamptz
         AND op.scheduled_start_at < $3::timestamptz
         AND ($4::uuid IS NULL OR op.piece_id <> $4)
      ${hasBeds ? `
      UNION ALL
      SELECT pb.assigned_nozzle_asset_id AS nozzle_id,
             pb.scheduled_start_at AS start_at,
             pb.scheduled_end_at   AS end_at
        FROM print_beds pb
       WHERE pb.company_id = $1
         AND pb.assigned_nozzle_asset_id IS NOT NULL
         AND pb.status IN ('scheduled','printing')
         AND pb.scheduled_end_at   > $2::timestamptz
         AND pb.scheduled_start_at < $3::timestamptz
      ` : ``}
    `;
    const nozzleBusyResult = await this.databaseService.query<{
      nozzle_id: string; start_at: string; end_at: string;
    }>(nozzleBusySql, [companyId, window.start.toISOString(), window.end.toISOString(), req.excludePieceId]);
    const busyByNozzle = new Map<string, Array<{ start: number; end: number }>>();
    for (const b of nozzleBusyResult.rows) {
      const arr = busyByNozzle.get(b.nozzle_id) ?? [];
      arr.push({ start: new Date(b.start_at).getTime(), end: new Date(b.end_at).getTime() });
      busyByNozzle.set(b.nozzle_id, arr);
    }
    for (const arr of busyByNozzle.values()) arr.sort((a, b) => a.start - b.start);

    // Also count *unscheduled* committed minutes — pieces assigned but not yet
    // on the timeline still eat capacity for the operator. They're not
    // intervals (no start/end), so they reduce the free total but don't shrink
    // the longest continuous gap.
    const unscheduledSql = `
      SELECT op.assigned_printer_id AS printer_id,
             SUM(COALESCE(op.slicer_print_time_minutes, 0))::int AS minutes
        FROM order_pieces op
        JOIN orders o ON o.order_id = op.order_id
       WHERE op.company_id = $1
         AND op.assigned_printer_id IS NOT NULL
         AND op.status IN ('assigned','ready')
         AND ($2::uuid IS NULL OR op.piece_id <> $2)
         AND o.deadline <= $3::date
       GROUP BY op.assigned_printer_id
    `;
    const unscheduledResult = await this.databaseService.query<{
      printer_id: string;
      minutes: number;
    }>(unscheduledSql, [companyId, req.excludePieceId, req.deadline]);
    const unscheduledByPrinter = new Map<string, number>();
    for (const u of unscheduledResult.rows) {
      unscheduledByPrinter.set(u.printer_id, u.minutes);
    }

    // ── Pull nozzle compatibility once; index by printer_id for stage 3+4.
    const nozzleSql = `
      SELECT
        pnc.printer_id,
        pnc.nozzle_asset_id,
        ai.nozzle_diameter_mm,
        ai.nozzle_material,
        COALESCE(asto.status, 'available') AS nozzle_status,
        asto.next_free_at::text             AS next_free_at
      FROM printer_nozzle_compatibility pnc
      JOIN asset_instances ai ON ai.asset_id = pnc.nozzle_asset_id
      LEFT JOIN asset_stock asto ON asto.asset_id = pnc.nozzle_asset_id
      WHERE pnc.company_id = $1
    `;
    const nozzlesResult = await this.databaseService.query<NozzleCandidateRow>(
      nozzleSql,
      [companyId]
    );

    const nozzlesByPrinter = new Map<string, NozzleCandidateRow[]>();
    for (const nozzle of nozzlesResult.rows) {
      const arr = nozzlesByPrinter.get(nozzle.printer_id) ?? [];
      arr.push(nozzle);
      nozzlesByPrinter.set(nozzle.printer_id, arr);
    }

    // The piece/bed now declares its material directly (Stage 2 compatibility).
    // Multicolor pieces carry one material per color slot; fall back to the
    // single material otherwise. De-duped so a repeated material warns once.
    const requiredMaterials: string[] =
      req.materials && req.materials.length > 0
        ? Array.from(new Set(req.materials))
        : req.material
          ? [req.material]
          : [];

    const candidates: CandidateResult["candidates"] = [];
    const eliminated: CandidateResult["eliminated"] = [];

    for (const printer of printersResult.rows) {
      // Compute free intervals = working ∩ ¬busy for this printer.
      const busy = busyByPrinter.get(printer.printer_id) ?? [];
      const free = this.subtractBusy(workingIntervals, busy);
      const freeMinutesScheduled = Math.round(
        free.reduce((s, f) => s + (f.end - f.start), 0) / 60_000
      );
      // Unscheduled (assigned/ready) pieces also eat capacity even though we
      // don't know yet which time-slot they'll take.
      const unscheduledMins = unscheduledByPrinter.get(printer.printer_id) ?? 0;
      const freeMinutesTotal = Math.max(0, freeMinutesScheduled - unscheduledMins);
      // Longest contiguous block — operator needs THIS many minutes available
      // in one shot to schedule the new piece without rearranging.
      const freeMinutesContinuous = Math.round(
        free.reduce((max, f) => Math.max(max, f.end - f.start), 0) / 60_000
      );

      // ── Stage 1: capacity check (and operational state).
      if (printer.is_under_maintenance) {
        eliminated.push({
          printer_id: printer.printer_id,
          brand: printer.brand,
          model: printer.model,
          stage: 1,
          reason: "Printer is under maintenance.",
        });
        continue;
      }
      if (printer.is_offline) {
        eliminated.push({
          printer_id: printer.printer_id,
          brand: printer.brand,
          model: printer.model,
          stage: 1,
          reason: "Printer is offline.",
        });
        continue;
      }
      if (freeMinutesTotal < threshold) {
        eliminated.push({
          printer_id: printer.printer_id,
          brand: printer.brand,
          model: printer.model,
          stage: 1,
          reason: `Only ${freeMinutesTotal} min free in this window (< ${threshold}).`,
        });
        continue;
      }

      // ── Stage 2: spec compatibility.
      if (
        req.technology &&
        req.technology !== printer.print_technology
      ) {
        eliminated.push({
          printer_id: printer.printer_id,
          brand: printer.brand,
          model: printer.model,
          stage: 2,
          reason: `Wrong technology: needs ${req.technology}, has ${printer.print_technology}.`,
        });
        continue;
      }
      // Material support is fuzzy (printers run more than their listed set),
      // so a mismatch is a SOFT warning, not an elimination — the operator
      // knows their hardware. Technology (FDM/MSLA) above stays a hard gate.
      // A multicolor piece warns once per material the printer doesn't list.
      let materialWarning: string | null = null;
      if (printer.compatible_materials && printer.compatible_materials.length > 0) {
        const unlisted = requiredMaterials.filter(
          (mat) => !printer.compatible_materials!.some((m) => materialsCompatible(mat, m))
        );
        if (unlisted.length > 0) {
          const quoted = unlisted.map((m) => `"${m}"`).join(", ");
          materialWarning = `Our records don't list this printer for ${quoted} (supports ${printer.compatible_materials.join(", ")}). If you're sure it can run ${unlisted.length > 1 ? "them" : quoted}, it's up for use.`;
        }
      }
      if (req.multicolor && !printer.is_multicolor) {
        eliminated.push({
          printer_id: printer.printer_id,
          brand: printer.brand,
          model: printer.model,
          stage: 2,
          reason: "Multicolor required, printer doesn't support it.",
        });
        continue;
      }

      // ── Stage 3: nozzle compatibility (only on printers passing Stage 2).
      const nozzles = nozzlesByPrinter.get(printer.printer_id) ?? [];
      const matchingNozzles = nozzles.filter((n) => {
        if (
          req.nozzleDiameterMm != null &&
          Number(n.nozzle_diameter_mm) !== Number(req.nozzleDiameterMm)
        ) {
          return false;
        }
        if (
          req.nozzleMaterial &&
          n.nozzle_material &&
          n.nozzle_material.toLowerCase() !== req.nozzleMaterial.toLowerCase()
        ) {
          return false;
        }
        return true;
      });
      if (matchingNozzles.length === 0) {
        eliminated.push({
          printer_id: printer.printer_id,
          brand: printer.brand,
          model: printer.model,
          stage: 3,
          reason: "No compatible nozzle (diameter / material mismatch).",
        });
        continue;
      }

      // ── Stage 4: nozzle availability — at least one matching nozzle must
      //    have a free window of ≥ `threshold` minutes that overlaps THIS
      //    printer's free time. The nozzle is its own resource (it may be
      //    mounted on other printers in this window), so we intersect the
      //    printer's busy set with the nozzle's busy set and measure the
      //    longest combined gap. The actual print duration is validated later
      //    at the slicer step / at placement (schedule() overlap checks).
      const eligibleNozzles = matchingNozzles.filter((n) => {
        if (n.nozzle_status === "damaged") return false;
        const nozzleBusy = busyByNozzle.get(n.nozzle_asset_id) ?? [];
        const combinedBusy = [...busy, ...nozzleBusy];
        const combinedFree = this.subtractBusy(workingIntervals, combinedBusy);
        const longestGapMin = Math.round(
          combinedFree.reduce((max, f) => Math.max(max, f.end - f.start), 0) / 60_000
        );
        return longestGapMin >= threshold;
      });
      if (eligibleNozzles.length === 0) {
        eliminated.push({
          printer_id: printer.printer_id,
          brand: printer.brand,
          model: printer.model,
          stage: 4,
          reason: "All compatible nozzles are busy or damaged.",
        });
        continue;
      }

      candidates.push({
        printer_id: printer.printer_id,
        brand: printer.brand,
        model: printer.model,
        serial_number: printer.serial_number,
        location: printer.location,
        free_minutes_total: freeMinutesTotal,
        free_minutes_continuous: freeMinutesContinuous,
        build_volume_x_mm: printer.build_volume_x_mm != null ? Number(printer.build_volume_x_mm) : null,
        build_volume_y_mm: printer.build_volume_y_mm != null ? Number(printer.build_volume_y_mm) : null,
        build_volume_z_mm: printer.build_volume_z_mm != null ? Number(printer.build_volume_z_mm) : null,
        material_warning: materialWarning,
        eligible_nozzles: eligibleNozzles.map((n) => ({
          nozzle_asset_id: n.nozzle_asset_id,
          nozzle_diameter_mm: Number(n.nozzle_diameter_mm),
          nozzle_material: n.nozzle_material,
          next_free_at: n.next_free_at,
        })),
      });
    }

    // Sort survivors by longest continuous gap first — that's the metric the
    // operator actually cares about when picking a printer.
    candidates.sort((a, b) => b.free_minutes_continuous - a.free_minutes_continuous);

    return {
      threshold_minutes: threshold,
      time_horizon: horizon,
      window_start: window.start.toISOString(),
      window_end: window.end.toISOString(),
      working_minutes_per_day: workingMinutesPerDay,
      candidates,
      eliminated,
    };
  }

  // ──────────────────────────────────────────────────────────
  // POST /api/jobs/:pieceId/assign
  // The hard-fail check + status transition to 'assigned'.
  // ──────────────────────────────────────────────────────────
  async assign(
    companyId: string,
    pieceId: string,
    input: AssignJobInput
  ): Promise<JobRow> {
    const piece = await this.loadJob(companyId, pieceId);
    // Re-assignment is allowed from any pre-execution state. Once a piece is
    // scheduled/printing/done/failed/cancelled, the operator must explicitly
    // back it out first (unschedule / cancel) — those edits are too dangerous
    // to do silently inside an assign call.
    if (
      piece.status !== "pending" &&
      piece.status !== "assigned" &&
      piece.status !== "ready"
    ) {
      throw new ConflictException(
        `Cannot assign a piece in status '${piece.status}'. Unschedule or cancel it first.`
      );
    }
    // A filament MATERIAL is required BEFORE assignment — the printer/material
    // compatibility check depends on it.
    if (!piece.required_filament_material) {
      throw new BadRequestException(
        "Choose a filament material for this piece before assigning a printer — compatibility is checked against it."
      );
    }

    // Recompute free minutes for THIS printer in the deadline horizon,
    // excluding minutes already committed by this very piece. Mirrors the
    // findCandidates calculation so the hard-fail check is consistent with
    // what the operator saw on the candidate card.
    const cfg = await this.getCompanyConfig(companyId);
    const window = this.resolveWindow("deadline", piece.order_deadline);
    const workingIntervals = this.workingIntervalsInWindow(window.start, window.end, cfg);

    const busyRes = await this.databaseService.query<{ start_at: string; end_at: string }>(
      `SELECT scheduled_start_at AS start_at, scheduled_end_at AS end_at
         FROM order_pieces
        WHERE assigned_printer_id = $1
          AND status IN ('scheduled','printing')
          AND piece_id <> $2
          AND scheduled_end_at   > $3::timestamptz
          AND scheduled_start_at < $4::timestamptz`,
      [input.printer_id, pieceId, window.start.toISOString(), window.end.toISOString()]
    );
    const busy = busyRes.rows
      .map((r) => ({
        start: new Date(r.start_at).getTime(),
        end: new Date(r.end_at).getTime(),
      }))
      .sort((a, b) => a.start - b.start);
    const freeIntervals = this.subtractBusy(workingIntervals, busy);
    const freeMinutesScheduled = Math.round(
      freeIntervals.reduce((s, f) => s + (f.end - f.start), 0) / 60_000
    );
    // Plus deduction for OTHER assigned/ready pieces with no schedule yet.
    const unsRes = await this.databaseService.query<{ minutes: number }>(
      `SELECT COALESCE(SUM(COALESCE(op.slicer_print_time_minutes, 0)), 0)::int AS minutes
         FROM order_pieces op
         JOIN orders o ON o.order_id = op.order_id
        WHERE op.assigned_printer_id = $1
          AND op.status IN ('assigned','ready')
          AND op.piece_id <> $2
          AND o.deadline <= $3::date`,
      [input.printer_id, pieceId, piece.order_deadline]
    );
    const unscheduledMins = unsRes.rows[0]?.minutes ?? 0;
    const free = Math.max(0, freeMinutesScheduled - unscheduledMins);

    if (input.slicer_print_time_minutes > free) {
      // The single automated rejection in the entire pipeline.
      throw new BadRequestException(
        `Slicer-reported time (${input.slicer_print_time_minutes} min) exceeds printer's free time (${free} min) before deadline.`
      );
    }

    // Verify the nozzle still belongs to a compatible row before locking it in.
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

    const hasStl = await this.hasStlColumn();
    // Build the SET clause dynamically so we only touch the STL column when
    // the migration has been applied.
    const stlSet = hasStl
      ? `, stl_file_url = COALESCE($8, stl_file_url),
           stl_file_uploaded_at = CASE WHEN $8 IS NOT NULL THEN now() ELSE stl_file_uploaded_at END`
      : ``;
    const values: unknown[] = [
      companyId,
      pieceId,
      input.printer_id,
      input.nozzle_asset_id,
      input.slicer_print_time_minutes,
      input.slicer_file_url ?? null,
      input.slicer_filament_used_grams ?? null,
    ];
    if (hasStl) values.push(input.stl_file_url ?? null);

    // Status decision is purely a function of the slicer file. The DB's
    // chk_ready_requires_core_data constraint already enforces that
    // status='ready' requires (printer, nozzle, slicer_file_url) — so we set
    // 'ready' when COALESCE(new, existing) slicer_file_url is non-null, and
    // 'assigned' otherwise. STL has no bearing on status.
    const updated = await this.databaseService.query<JobRow>(
      `
        UPDATE order_pieces
           SET assigned_printer_id        = $3,
               assigned_nozzle_asset_id   = $4,
               slicer_print_time_minutes  = $5,
               slicer_file_url            = COALESCE($6, slicer_file_url),
               slicer_file_uploaded_at    = CASE WHEN $6 IS NOT NULL THEN now() ELSE slicer_file_uploaded_at END,
               slicer_filament_used_grams = COALESCE($7, slicer_filament_used_grams)
               ${stlSet},
               status = CASE
                 WHEN COALESCE($6, slicer_file_url) IS NOT NULL THEN 'ready'
                 ELSE 'assigned'
               END
         WHERE company_id = $1 AND piece_id = $2
         RETURNING piece_id
      `,
      values
    );
    if (updated.rowCount === 0) {
      throw new NotFoundException("Piece not found.");
    }

    // Multicolor: persist the per-slot slicer demand and sync the piece total
    // to their sum so reservation + scheduling guards stay consistent. The
    // total is recomputed from the slot rows (not the payload), so a partial
    // color_slot_grams update can't silently undercount the total.
    if (input.color_slot_grams && input.color_slot_grams.length > 0) {
      for (const entry of input.color_slot_grams) {
        await this.databaseService.query(
          `UPDATE order_piece_color_slots
              SET slicer_grams = $3
            WHERE company_id = $1 AND piece_id = $2 AND sequence_order = $4`,
          [companyId, pieceId, entry.grams, entry.sequence_order]
        );
      }
      await this.databaseService.query(
        `UPDATE order_pieces op
            SET slicer_filament_used_grams = (
              SELECT COALESCE(SUM(slicer_grams), 0)
                FROM order_piece_color_slots
               WHERE company_id = $1 AND piece_id = $2
            )
          WHERE op.company_id = $1 AND op.piece_id = $2`,
        [companyId, pieceId]
      );
    }

    return this.loadJob(companyId, pieceId);
  }

  // ──────────────────────────────────────────────────────────
  // PATCH /api/jobs/:pieceId/files
  // Attach or replace one (or both) of the two file fields outside the
  // assignment flow. Doesn't touch status — that's the assign endpoint's job.
  // ──────────────────────────────────────────────────────────
  async updateFiles(
    companyId: string,
    pieceId: string,
    input: UpdatePieceFilesInput
  ): Promise<JobRow> {
    const piece = await this.loadJob(companyId, pieceId);
    const hasStl = await this.hasStlColumn();

    // ── Guardrails on the slicer field ─────────────────────────
    // Removing the slicer file from a piece that's already 'scheduled' or
    // 'printing' would violate chk_scheduled_requires_core_data and surface a
    // raw constraint name to the operator. We catch it here and explain.
    if (
      input.slicer_file_url === null &&
      (piece.status === "scheduled" || piece.status === "printing")
    ) {
      throw new ConflictException(
        `Cannot remove the slicer file while the piece is '${piece.status}'. Unschedule first.`
      );
    }
    // 'done' / 'cancelled' / 'failed' are terminal — files can still be
    // viewed/downloaded, but mutations are weird. Be explicit.
    if (
      input.slicer_file_url !== undefined &&
      (piece.status === "done" || piece.status === "failed")
    ) {
      throw new ConflictException(
        `Cannot change the slicer file on a '${piece.status}' piece.`
      );
    }

    const sets: string[] = [];
    const values: unknown[] = [companyId, pieceId];
    let slicerChanged = false;
    let slicerNewValue: string | null = piece.slicer_file_url; // resolved post-update

    if (input.slicer_file_url !== undefined) {
      values.push(input.slicer_file_url);
      const idx = values.length;
      sets.push(`slicer_file_url = $${idx}`);
      sets.push(`slicer_file_uploaded_at = CASE WHEN $${idx}::text IS NULL THEN NULL ELSE now() END`);
      slicerChanged = true;
      slicerNewValue = input.slicer_file_url;
    }
    if (input.stl_file_url !== undefined) {
      let stlAvailable = hasStl;
      if (!stlAvailable) {
        // The cached "missing" answer may be stale because the operator just
        // applied the migration. Force a re-check before failing.
        this.invalidateStlCache();
        stlAvailable = await this.hasStlColumn();
      }
      if (!stlAvailable) {
        throw new BadRequestException(
          "STL file support requires the `db_add_order_piece_stl_file.sql` migration. Apply it and try again."
        );
      }
      values.push(input.stl_file_url);
      const idx = values.length;
      sets.push(`stl_file_url = $${idx}`);
      sets.push(`stl_file_uploaded_at = CASE WHEN $${idx}::text IS NULL THEN NULL ELSE now() END`);
    }

    // ── Auto-status transition based on slicer presence ────────
    // The slicer file gates the lifecycle: removing it FULLY de-assigns the
    // piece (printer + nozzle + slicer-time wiped, status → 'pending'). This
    // matches operator intuition — without a slicer file the assignment
    // doesn't mean anything. Uploading a slicer file on an already-assigned
    // piece promotes it to 'ready'. STL changes never touch any of this.
    if (slicerChanged && (piece.status === "assigned" || piece.status === "ready")) {
      if (slicerNewValue == null) {
        // Slicer removed → full reset.
        sets.push(`assigned_printer_id        = NULL`);
        sets.push(`assigned_nozzle_asset_id   = NULL`);
        sets.push(`slicer_print_time_minutes  = NULL`);
        sets.push(`slicer_filament_used_grams = NULL`);
        sets.push(`status = 'pending'`);
      } else if (piece.assigned_printer_id && piece.assigned_nozzle_asset_id) {
        sets.push(`status = 'ready'`);
      } else {
        sets.push(`status = 'assigned'`);
      }
    }

    if (sets.length === 0) return this.loadJob(companyId, pieceId);

    await this.databaseService.query(
      `UPDATE order_pieces SET ${sets.join(", ")}
        WHERE company_id = $1 AND piece_id = $2`,
      values
    );
    // The slicer-driven auto-status branch can move the piece between
    // pending/assigned/ready — keep the parent order in step.
    if (sets.some((s) => s.trimStart().startsWith("status ="))) {
      await this.syncOrderStatus(companyId, piece.order_id);
    }
    return this.loadJob(companyId, pieceId);
  }

  // ──────────────────────────────────────────────────────────
  // POST /api/jobs/:pieceId/unassign
  // ──────────────────────────────────────────────────────────
  async unassign(companyId: string, pieceId: string): Promise<JobRow> {
    const piece = await this.loadJob(companyId, pieceId);
    if (piece.status !== "assigned" && piece.status !== "ready") {
      throw new ConflictException(
        `Only 'assigned' / 'ready' pieces can be unassigned (current: '${piece.status}').`
      );
    }
    // Backing out the printer also releases any reserved spool(s).
    await this.releaseSpools(companyId, pieceId);
    await this.databaseService.query(
      `
        UPDATE order_pieces
           SET assigned_printer_id       = NULL,
               assigned_nozzle_asset_id  = NULL,
               status                    = 'pending'
         WHERE company_id = $1 AND piece_id = $2
      `,
      [companyId, pieceId]
    );
    await this.syncOrderStatus(companyId, piece.order_id);
    return this.loadJob(companyId, pieceId);
  }

  // ──────────────────────────────────────────────────────────
  // POST /api/jobs/:pieceId/schedule
  // End = start + slicer_print_time_minutes. Validates no overlap on the
  // assigned printer.
  // ──────────────────────────────────────────────────────────
  // Best-effort piece-lifecycle logging into the shared order_history feed
  // (same table the Orders page reads). Never throws — a logging failure must
  // not break the action that triggered it.
  // Re-derive the parent order's status after a piece transition (schedule /
  // start / complete / fail / unassign / reprint …). Delegates to the shared
  // cascade helper so the jobs flow keeps orders in lock-step with the Orders
  // page. Best-effort: a status-sync failure must not fail the transition the
  // operator just performed.
  private async syncOrderStatus(companyId: string, orderId: string): Promise<void> {
    try {
      await recomputeOrderStatusTx(
        {
          query: <T extends QueryResultRow = QueryResultRow>(
            text: string,
            values?: unknown[]
          ): Promise<QueryResult<T>> => this.databaseService.query<T>(text, values),
        },
        companyId,
        orderId
      );
    } catch { /* ignore — order auto-status is non-critical to the action */ }
  }

  private async recordPieceEvent(
    companyId: string,
    piece: JobRow,
    eventType: string,
    description: string
  ): Promise<void> {
    try {
      await this.databaseService.query(
        `INSERT INTO order_history
           (company_id, entity_type, event_type, order_id, order_number, piece_id, piece_name, description)
         VALUES ($1, 'piece', $2, $3, $4, $5, $6, $7)`,
        [companyId, eventType, piece.order_id, piece.order_reference, piece.piece_id, piece.piece_name, description]
      );
    } catch { /* ignore — history is non-critical */ }
  }

  async schedule(
    companyId: string,
    pieceId: string,
    input: ScheduleJobInput
  ): Promise<JobRow> {
    const piece = await this.loadJob(companyId, pieceId);
    // 'assigned' is intentionally NOT allowed here — by design that status
    // means the slicer file is missing. The DB's chk_scheduled_requires_core_data
    // would reject anyway; the explicit check gives a friendlier message.
    if (piece.status !== "ready" && piece.status !== "scheduled") {
      throw new ConflictException(
        `Cannot schedule a '${piece.status}' piece. Upload a slicer file first (status must reach 'ready').`
      );
    }
    // Friendly preflight — the DB enforces these via chk_scheduled_requires_core_data,
    // but its message is "new row for relation ... violates check constraint ..." which
    // is useless to operators. We check each precondition explicitly here.
    if (!piece.assigned_printer_id) {
      throw new BadRequestException(
        "Piece has no assigned printer — assign one before scheduling."
      );
    }
    if (!piece.assigned_nozzle_asset_id) {
      throw new BadRequestException(
        "Piece has no assigned nozzle — assign one before scheduling."
      );
    }
    if (!piece.slicer_file_url) {
      throw new BadRequestException(
        "Piece has no slicer file — upload one first. (The slicer file gates scheduling, the STL doesn't.)"
      );
    }
    if (piece.slicer_print_time_minutes == null) {
      throw new BadRequestException(
        "Piece has no slicer print time — re-run the assignment flow."
      );
    }
    // Filament is optional while editing/assigning, but MANDATORY to schedule:
    // committing a print window reserves filament across the spool timeline, so
    // the piece must declare which filament it consumes.
    if (!piece.required_filament_material) {
      throw new BadRequestException(
        "Set a filament material before scheduling."
      );
    }
    // A physical spool instance must be reserved (assigned from stock) before
    // scheduling — that's the third timeline (printer + nozzle + spool).
    const reservedSpools = await this.databaseService.query<{ spool_asset_id: string }>(
      `SELECT spool_asset_id FROM order_piece_spools WHERE company_id = $1 AND piece_id = $2`,
      [companyId, pieceId]
    );
    if (reservedSpools.rowCount === 0) {
      throw new BadRequestException(
        "Reserve a filament spool from inventory before scheduling (assign a physical spool instance)."
      );
    }
    const start = new Date(input.start_at);
    const end = new Date(start.getTime() + piece.slicer_print_time_minutes * 60_000);

    // Can't schedule a print into the past (60s grace for clock skew / latency).
    if (start.getTime() < Date.now() - 60_000) {
      throw new BadRequestException(
        "Can't schedule a print in the past — pick a start time from now onward."
      );
    }

    // The reserved spool(s) can't be mounted on two printers at once — reject
    // if any is already feeding another scheduled/printing piece in this window.
    const spoolIds = reservedSpools.rows.map((r) => r.spool_asset_id);
    const spoolOverlap = await this.databaseService.query<{ piece_id: string }>(
      `SELECT op.piece_id
         FROM order_pieces op
         JOIN order_piece_spools ops ON ops.piece_id = op.piece_id
        WHERE op.company_id = $1
          AND op.piece_id <> $2
          AND ops.spool_asset_id = ANY($3::uuid[])
          AND op.status IN ('scheduled','printing')
          AND op.scheduled_start_at < $5
          AND op.scheduled_end_at   > $4
        LIMIT 1`,
      [companyId, pieceId, spoolIds, start.toISOString(), end.toISOString()]
    );
    if (spoolOverlap.rowCount && spoolOverlap.rowCount > 0) {
      throw new ConflictException(
        "A reserved spool is already feeding another print in this time slot — a spool can't be on two printers at once."
      );
    }

    // Overlap check on the same printer (skipping this piece's own existing block).
    const overlapRes = await this.databaseService.query<{ piece_id: string }>(
      `
        SELECT piece_id FROM order_pieces
         WHERE company_id = $1
           AND assigned_printer_id = $2
           AND piece_id <> $3
           AND status IN ('scheduled','printing')
           AND scheduled_start_at < $5
           AND scheduled_end_at   > $4
         LIMIT 1
      `,
      [companyId, piece.assigned_printer_id, pieceId, start.toISOString(), end.toISOString()]
    );
    if (overlapRes.rowCount && overlapRes.rowCount > 0) {
      throw new ConflictException(
        "Time slot overlaps an existing scheduled block on this printer."
      );
    }
    // Also check beds occupying the same printer — they're a different table
    // so the order_pieces exclusion constraint can't catch them.
    if (await this.hasBedsTable()) {
      const bedOverlap = await this.databaseService.query<{ bed_id: string }>(
        `SELECT bed_id FROM print_beds
          WHERE company_id = $1
            AND assigned_printer_id = $2
            AND status IN ('scheduled','printing')
            AND scheduled_start_at < $4
            AND scheduled_end_at   > $3
          LIMIT 1`,
        [companyId, piece.assigned_printer_id, start.toISOString(), end.toISOString()]
      );
      if (bedOverlap.rowCount && bedOverlap.rowCount > 0) {
        throw new ConflictException(
          "Time slot overlaps a print bed already scheduled on this printer."
        );
      }
    }

    // The assigned nozzle is its own resource — it can't be mounted on two
    // printers at once. Reject if it's already committed elsewhere in this
    // window (across pieces and beds). This is the placement-time validation
    // that the print's actual times are viable for the nozzle, not just the
    // printer.
    if (piece.assigned_nozzle_asset_id) {
      const nozzlePieceOverlap = await this.databaseService.query<{ piece_id: string }>(
        `SELECT piece_id FROM order_pieces
          WHERE company_id = $1
            AND assigned_nozzle_asset_id = $2
            AND piece_id <> $3
            AND status IN ('scheduled','printing')
            AND scheduled_start_at < $5
            AND scheduled_end_at   > $4
          LIMIT 1`,
        [companyId, piece.assigned_nozzle_asset_id, pieceId, start.toISOString(), end.toISOString()]
      );
      if (nozzlePieceOverlap.rowCount && nozzlePieceOverlap.rowCount > 0) {
        throw new ConflictException(
          "The assigned nozzle is already in use by another print in this time slot."
        );
      }
      if (await this.hasBedsTable()) {
        const nozzleBedOverlap = await this.databaseService.query<{ bed_id: string }>(
          `SELECT bed_id FROM print_beds
            WHERE company_id = $1
              AND assigned_nozzle_asset_id = $2
              AND status IN ('scheduled','printing')
              AND scheduled_start_at < $4
              AND scheduled_end_at   > $3
            LIMIT 1`,
          [companyId, piece.assigned_nozzle_asset_id, start.toISOString(), end.toISOString()]
        );
        if (nozzleBedOverlap.rowCount && nozzleBedOverlap.rowCount > 0) {
          throw new ConflictException(
            "The assigned nozzle is already in use by a print bed in this time slot."
          );
        }
      }
    }

    await this.databaseService.query(
      `
        UPDATE order_pieces
           SET scheduled_start_at = $3,
               scheduled_end_at   = $4,
               scheduled_at       = now(),
               status             = 'scheduled'
         WHERE company_id = $1 AND piece_id = $2
      `,
      [companyId, pieceId, start.toISOString(), end.toISOString()]
    );
    await this.recordPieceEvent(
      companyId, piece, "scheduled",
      `Piece "${piece.piece_name}" scheduled on ${piece.assigned_printer_label ?? "a printer"} for ${start.toISOString()}.`
    );
    await this.syncOrderStatus(companyId, piece.order_id);
    return this.loadJob(companyId, pieceId);
  }

  async unschedule(companyId: string, pieceId: string): Promise<JobRow> {
    const piece = await this.loadJob(companyId, pieceId);
    if (piece.status !== "scheduled") {
      throw new ConflictException(
        `Only 'scheduled' pieces can be unscheduled (current: '${piece.status}').`
      );
    }
    // After unschedule the piece keeps printer+nozzle+slicer (it was 'scheduled'
    // so all three must have been present per chk_scheduled_requires_core_data),
    // so we drop back to 'ready'. If the slicer file is somehow missing, fall
    // back to 'assigned'.
    const target = piece.slicer_file_url ? "ready" : "assigned";
    await this.databaseService.query(
      `
        UPDATE order_pieces
           SET scheduled_start_at = NULL,
               scheduled_end_at   = NULL,
               scheduled_at       = NULL,
               status             = $3
         WHERE company_id = $1 AND piece_id = $2
      `,
      [companyId, pieceId, target]
    );
    await this.syncOrderStatus(companyId, piece.order_id);
    return this.loadJob(companyId, pieceId);
  }

  // ──────────────────────────────────────────────────────────
  // POST /api/jobs/:pieceId/start
  // ──────────────────────────────────────────────────────────
  async start(companyId: string, pieceId: string): Promise<JobRow> {
    const piece = await this.loadJob(companyId, pieceId);
    if (
      piece.status !== "scheduled" &&
      piece.status !== "assigned" &&
      piece.status !== "ready"
    ) {
      throw new ConflictException(
        `Only assigned/ready/scheduled pieces can be started (current: '${piece.status}').`
      );
    }
    if (!piece.assigned_printer_id) {
      throw new BadRequestException(
        "Piece has no assigned printer — cannot start printing."
      );
    }
    const printerId = piece.assigned_printer_id;
    await this.databaseService.transaction(async (client) => {
      await client.query(
        `
          UPDATE order_pieces
             SET status            = 'printing',
                 print_started_at  = COALESCE(print_started_at, now())
           WHERE company_id = $1 AND piece_id = $2
        `,
        [companyId, pieceId]
      );
      // Lock the assigned printer for this run (live counterpart of the old
      // startPieceExecution's printer_stock write).
      await markPrinterPrintingTx(client, companyId, printerId, piece.order_id, pieceId);
    });
    await this.syncOrderStatus(companyId, piece.order_id);
    return this.loadJob(companyId, pieceId);
  }

  // ──────────────────────────────────────────────────────────
  // POST /api/jobs/:pieceId/complete
  // ──────────────────────────────────────────────────────────
  async complete(
    companyId: string,
    pieceId: string,
    input: CompleteJobInput
  ): Promise<JobRow> {
    const piece = await this.loadJob(companyId, pieceId);
    // A print can be completed from 'scheduled' (the time arrived and the
    // operator confirms the outcome) or 'printing'. There's no separate
    // "start" step — scheduling commits the slot, completion records reality.
    if (piece.status !== "printing" && piece.status !== "scheduled") {
      throw new ConflictException(
        `Only scheduled/printing pieces can be completed (current: '${piece.status}').`
      );
    }
    await this.databaseService.query(
      `
        UPDATE order_pieces
           SET status                     = $3,
               print_started_at           = COALESCE(print_started_at, scheduled_start_at, now()),
               print_completed_at         = now(),
               actual_print_time_minutes  = COALESCE($4, actual_print_time_minutes),
               actual_filament_used_grams = COALESCE($5, actual_filament_used_grams)
         WHERE company_id = $1 AND piece_id = $2
      `,
      [
        companyId,
        pieceId,
        input.outcome,
        input.actual_print_time_minutes ?? null,
        input.actual_filament_used_grams ?? null,
      ]
    );
    // The print ran (done or failed) → the reserved filament is consumed:
    // deduct it from the spool's remaining grams and release the reservation,
    // and free the assigned printer (live counterpart of the old
    // releaseExecutionResources). No-op for a never-started 'scheduled' piece.
    const completePrinterId = piece.assigned_printer_id;
    await this.databaseService.transaction(async (c) => {
      await this.consumeSpoolsTx(c, companyId, pieceId);
      if (completePrinterId) {
        await releasePrinterForPieceTx(c, companyId, completePrinterId, pieceId);
      }
    });
    await this.recordPieceEvent(
      companyId, piece, input.outcome === "done" ? "completed" : "failed",
      `Piece "${piece.piece_name}" marked ${input.outcome}.`
    );
    await this.syncOrderStatus(companyId, piece.order_id);
    return this.loadJob(companyId, pieceId);
  }

  // ──────────────────────────────────────────────────────────
  // POST /api/jobs/:pieceId/reprint
  // A failed print is not a dead end — it goes straight back into the normal
  // schedulable pool. We clear the old (now-past) window and the failed run's
  // execution stamps, and revert status to the furthest schedulable state its
  // retained data allows (ready if it still has printer+nozzle+slicer, else
  // assigned, else pending). The failure stays recorded in order_history; the
  // already-consumed filament is NOT given back (it was physically used), and
  // the reprint reserves fresh filament when it's scheduled again.
  // ──────────────────────────────────────────────────────────
  async reprint(companyId: string, pieceId: string): Promise<JobRow> {
    const piece = await this.loadJob(companyId, pieceId);
    if (piece.status !== "failed") {
      throw new ConflictException(
        `Only failed pieces can be re-queued for reprint (current: '${piece.status}').`
      );
    }
    const target =
      piece.assigned_printer_id && piece.assigned_nozzle_asset_id && piece.slicer_file_url
        ? "ready"
        : piece.assigned_printer_id
          ? "assigned"
          : "pending";
    await this.databaseService.query(
      `UPDATE order_pieces
          SET status                     = $3,
              scheduled_start_at         = NULL,
              scheduled_end_at           = NULL,
              scheduled_at               = NULL,
              print_started_at           = NULL,
              print_completed_at         = NULL,
              actual_print_time_minutes  = NULL,
              actual_filament_used_grams = NULL
        WHERE company_id = $1 AND piece_id = $2`,
      [companyId, pieceId, target]
    );
    await this.recordPieceEvent(
      companyId, piece, "requeued",
      `Piece "${piece.piece_name}" re-queued for reprint after a failed run.`
    );
    await this.syncOrderStatus(companyId, piece.order_id);
    return this.loadJob(companyId, pieceId);
  }

  // ──────────────────────────────────────────────────────────
  // POST /api/jobs/:pieceId/cancel
  // ──────────────────────────────────────────────────────────
  // ──────────────────────────────────────────────────────────
  // POST /api/jobs/:pieceId/restore
  // Bring a cancelled piece back. The operator can choose to restore it
  // to 'pending' (a clean slate — printer/nozzle/slicer cleared) or to
  // 'assigned' if the piece still has its assignment fields cached.
  // Either way it lands unscheduled — the operator must reschedule.
  // ──────────────────────────────────────────────────────────
  async restore(
    companyId: string,
    pieceId: string,
    input: RestoreJobInput
  ): Promise<JobRow> {
    const piece = await this.loadJob(companyId, pieceId);
    if (piece.status !== "cancelled") {
      throw new ConflictException(
        `Only cancelled pieces can be restored (current: '${piece.status}').`
      );
    }
    if (input.to === "assigned") {
      // The assigned status requires assigned_printer_id. We preserved this
      // when cancelling, so it should already be set — but verify.
      if (!piece.assigned_printer_id) {
        throw new BadRequestException(
          "Cannot restore as 'assigned': the piece has no printer recorded. Use restore-as-pending instead."
        );
      }
      // If the piece carries all `ready` prereqs (printer + nozzle + slicer
      // file), promote it straight to 'ready' so the operator can schedule
      // immediately without having to re-trigger the slicer step.
      const targetStatus =
        piece.assigned_nozzle_asset_id && piece.slicer_file_url
          ? "ready"
          : "assigned";
      await this.databaseService.query(
        `UPDATE order_pieces
            SET status             = $3,
                scheduled_start_at = NULL,
                scheduled_end_at   = NULL,
                scheduled_at       = NULL
          WHERE company_id = $1 AND piece_id = $2`,
        [companyId, pieceId, targetStatus]
      );
    } else {
      // Pending: clear every assignment field so a fresh assignment is needed.
      // Slicer file URL is retained — the file itself is harmless to keep and
      // saves a re-upload if the operator picks the same printer profile again.
      await this.databaseService.query(
        `UPDATE order_pieces
            SET status                     = 'pending',
                assigned_printer_id        = NULL,
                assigned_nozzle_asset_id   = NULL,
                slicer_print_time_minutes  = NULL,
                slicer_filament_used_grams = NULL,
                scheduled_start_at         = NULL,
                scheduled_end_at           = NULL,
                scheduled_at               = NULL
          WHERE company_id = $1 AND piece_id = $2`,
        [companyId, pieceId]
      );
    }
    await this.syncOrderStatus(companyId, piece.order_id);
    return this.loadJob(companyId, pieceId);
  }

  async cancel(companyId: string, pieceId: string): Promise<JobRow> {
    const piece = await this.loadJob(companyId, pieceId);
    if (piece.status === "done" || piece.status === "cancelled") {
      throw new ConflictException(
        `Piece already in terminal status '${piece.status}'.`
      );
    }
    await this.databaseService.transaction(async (client) => {
      // Cancelling frees the reserved spool grams.
      await this.releaseSpoolsTx(client, companyId, pieceId);
      // …and frees the assigned printer if this piece was holding it (live
      // counterpart of releaseExecutionResources). No-op when not printing.
      if (piece.assigned_printer_id) {
        await releasePrinterForPieceTx(client, companyId, piece.assigned_printer_id, pieceId);
      }
      await client.query(
        `
          UPDATE order_pieces
             SET status             = 'cancelled',
                 scheduled_start_at = NULL,
                 scheduled_end_at   = NULL,
                 scheduled_at       = NULL
           WHERE company_id = $1 AND piece_id = $2
        `,
        [companyId, pieceId]
      );
      // If this piece was on a bed, cancelling it invalidates the bed
      // arrangement — re-evaluate (dismantle / cancel / delete the bed).
      const bedRow = await client.query<{ bed_id: string | null }>(
        `SELECT bed_id FROM order_pieces WHERE company_id = $1 AND piece_id = $2`,
        [companyId, pieceId]
      );
      const bedId = bedRow.rows[0]?.bed_id;
      if (bedId) {
        await reevaluateBedAfterPieceRemoval(client, companyId, bedId);
      }
      // Re-derive the order within the SAME transaction so a cancel that
      // empties the order's active work settles its status atomically.
      await recomputeOrderStatusTx(client, companyId, piece.order_id);
    });
    return this.loadJob(companyId, pieceId);
  }

  // ──────────────────────────────────────────────────────────
  // GET /api/jobs/timeline
  // Returns blocks per printer plus the floating "assigned but unscheduled"
  // bucket so the UI can render the click-to-place sidebar.
  // ──────────────────────────────────────────────────────────
  // ──────────────────────────────────────────────────────────
  // GET /api/jobs/printers/:printerId/timeline
  // Per-printer slice of the global timeline — the schedule step in the
  // assignment wizard renders just one printer's lane plus its floating
  // bucket (assigned + ready pieces on this printer).
  // ──────────────────────────────────────────────────────────
  /**
   * Bed rows shaped exactly like JobRow (piece_id ← bed_id) + an is_bed flag,
   * so beds drop into the same timeline structures as pieces. `whereClause`
   * receives the print_beds alias `pb`.
   */
  private bedAsJobSelectSql(whereClause: string, orderBy: string, excludeDraftOrders = false): string {
    const orderStatusClause = excludeDraftOrders
      ? `
         AND EXISTS (
           SELECT 1
             FROM order_pieces op
             JOIN orders o ON o.order_id = op.order_id AND o.company_id = op.company_id
            WHERE op.company_id = pb.company_id
              AND op.bed_id = pb.bed_id
              AND o.status IN ('confirmed','in_progress','completed')
         )`
      : "";
    return `
      SELECT pb.bed_id AS piece_id,
             NULL::uuid AS order_id,
             pb.bed_name AS order_reference,
             pb.effective_deadline::text AS order_deadline,
             pb.bed_name AS piece_name,
             pb.description,
             pb.status,
             pb.assigned_printer_id,
             CASE WHEN pi.printer_id IS NOT NULL THEN pi.brand || ' ' || pi.model ELSE NULL END AS assigned_printer_label,
             pb.assigned_nozzle_asset_id,
             pb.required_print_technology,
             pb.required_nozzle_diameter_mm,
             pb.required_nozzle_material,
             pb.required_filament_ref_id,
             pb.required_filament_material,
             NULL::text AS required_filament_label,
             NULL::text AS required_color,
             pb.required_multicolor_capable,
             pb.slicer_print_time_minutes,
             pb.slicer_filament_used_grams,
             pb.slicer_file_url,
             pb.stl_file_url,
             pb.scheduled_start_at,
             pb.scheduled_end_at,
             pb.print_started_at,
             pb.print_completed_at,
             NULL::text AS customer_name,
             TRUE AS is_bed
        FROM print_beds pb
        LEFT JOIN printer_instances pi ON pi.printer_id = pb.assigned_printer_id
       ${whereClause}
       ${orderStatusClause}
       ORDER BY ${orderBy}
    `;
  }

  // Physical spool(s) each block reserves, keyed by the block's id (piece_id, or
  // bed_id for bed blocks). Pieces map directly through order_piece_spools; a
  // bed's reservation is anchored on its child pieces, rolled up under the
  // bed_id. Shared by the per-printer, global, and (now) all timeline views so
  // every lane can pivot by literal inventory spool, not just material family.
  private async spoolIdsByBlock(
    companyId: string,
    pieceIds: string[],
    bedIds: string[]
  ): Promise<Map<string, string[]>> {
    const spoolsByBlock = new Map<string, string[]>();
    if (pieceIds.length > 0) {
      const r = await this.databaseService.query<{ piece_id: string; spool_asset_ids: string[] }>(
        `SELECT piece_id, array_agg(DISTINCT spool_asset_id) AS spool_asset_ids
           FROM order_piece_spools
          WHERE company_id = $1 AND piece_id = ANY($2::uuid[])
          GROUP BY piece_id`,
        [companyId, pieceIds]
      );
      for (const row of r.rows) spoolsByBlock.set(row.piece_id, row.spool_asset_ids);
    }
    if (bedIds.length > 0) {
      const r = await this.databaseService.query<{ bed_id: string; spool_asset_ids: string[] }>(
        `SELECT op.bed_id, array_agg(DISTINCT ops.spool_asset_id) AS spool_asset_ids
           FROM order_piece_spools ops
           JOIN order_pieces op ON op.piece_id = ops.piece_id
          WHERE ops.company_id = $1 AND op.bed_id = ANY($2::uuid[])
          GROUP BY op.bed_id`,
        [companyId, bedIds]
      );
      for (const row of r.rows) spoolsByBlock.set(row.bed_id, row.spool_asset_ids);
    }
    return spoolsByBlock;
  }

  async printerTimeline(companyId: string, printerId: string, query: TimelineQuery) {
    const hasStl = await this.hasStlColumn();
    const hasBeds = await this.hasBedsTable();
    const [printerRes, scheduledRes, floatingRes] = await Promise.all([
      this.databaseService.query<{
        printer_id: string;
        brand: string;
        model: string;
        location: string | null;
        is_under_maintenance: boolean;
        is_offline: boolean;
      }>(
        `SELECT pi.printer_id, pi.brand, pi.model, pi.location,
                COALESCE(ps.is_under_maintenance, FALSE) AS is_under_maintenance,
                COALESCE(ps.is_offline, FALSE) AS is_offline
           FROM printer_instances pi
           LEFT JOIN printer_stock ps ON ps.printer_id = pi.printer_id
          WHERE pi.company_id = $1 AND pi.printer_id = $2`,
        [companyId, printerId]
      ),
      this.databaseService.query<JobRow>(
        this.jobSelectSql(
          hasStl,
          // Includes done/failed so completed prints remain visible on the lane
          // as locked history (the UI renders them non-draggable).
          `WHERE op.company_id = $1
             AND op.assigned_printer_id = $2
             AND op.status IN ('scheduled','printing','done','failed')
             AND op.scheduled_start_at < $4
             AND op.scheduled_end_at   > $3`,
          "op.scheduled_start_at ASC",
          true
        ),
        [companyId, printerId, query.from, query.to]
      ),
      this.databaseService.query<JobRow>(
        this.jobSelectSql(
          hasStl,
          `WHERE op.company_id = $1
             AND op.assigned_printer_id = $2
             AND op.status IN ('assigned','ready')`,
          "o.deadline ASC NULLS LAST, op.created_at ASC",
          true
        ),
        [companyId, printerId]
      ),
    ]);

    if (printerRes.rowCount === 0) {
      throw new NotFoundException("Printer not found.");
    }

    // Union beds occupying / waiting on this printer so the schedule lane is
    // identical to the piece flow (the bed being scheduled appears as a
    // floating chip; other beds appear as blocks).
    let bedScheduled: Array<JobRow & { is_bed?: boolean }> = [];
    let bedFloating: Array<JobRow & { is_bed?: boolean }> = [];
    if (hasBeds) {
      const [bs, bf] = await Promise.all([
        this.databaseService.query<JobRow & { is_bed?: boolean }>(
          this.bedAsJobSelectSql(
            `WHERE pb.company_id = $1 AND pb.assigned_printer_id = $2
               AND pb.status IN ('scheduled','printing','done','failed')
               AND pb.scheduled_start_at < $4 AND pb.scheduled_end_at > $3`,
            "pb.scheduled_start_at ASC",
            true
          ),
          [companyId, printerId, query.from, query.to]
        ),
        this.databaseService.query<JobRow & { is_bed?: boolean }>(
          this.bedAsJobSelectSql(
            `WHERE pb.company_id = $1 AND pb.assigned_printer_id = $2
               AND pb.status IN ('assigned','ready')`,
            "pb.effective_deadline ASC NULLS LAST, pb.created_at ASC",
            true
          ),
          [companyId, printerId]
        ),
      ]);
      bedScheduled = bs.rows;
      bedFloating = bf.rows;
    }

    // Tag each scheduled block with the spool(s) it reserves, so the schedule
    // step can show a lane per involved spool (not just the job being scheduled).
    const spoolsByBlock = await this.spoolIdsByBlock(
      companyId,
      scheduledRes.rows.map((r) => r.piece_id),
      bedScheduled.map((b) => b.piece_id)
    );
    const withSpools = <T extends JobRow & { is_bed?: boolean }>(rows: T[]) =>
      rows.map((b) => ({ ...b, spool_asset_ids: spoolsByBlock.get(b.piece_id) ?? [] }));

    return {
      printer: printerRes.rows[0]!,
      scheduled: [...withSpools(scheduledRes.rows), ...withSpools(bedScheduled)],
      floating: [...floatingRes.rows, ...bedFloating],
    };
  }

  // ──────────────────────────────────────────────────────────
  // NOZZLE timeline — a nozzle is its own resource, independent of any
  // single printer. It can be mounted on different printers at different
  // times, so its lane shows every job (piece OR bed) running through it,
  // each block carrying the printer it's mounted on. Mirrors printerTimeline.
  // ──────────────────────────────────────────────────────────
  async nozzleTimeline(companyId: string, nozzleAssetId: string, query: TimelineQuery) {
    const hasStl = await this.hasStlColumn();
    const hasBeds = await this.hasBedsTable();
    const [nozzleRes, scheduledRes, floatingRes] = await Promise.all([
      this.databaseService.query<{
        nozzle_asset_id: string;
        nozzle_diameter_mm: number | null;
        nozzle_material: string | null;
        nozzle_brand: string | null;
        status: string;
        next_free_at: string | null;
      }>(
        `SELECT ai.asset_id AS nozzle_asset_id, ai.nozzle_diameter_mm, ai.nozzle_material,
                ai.nozzle_brand, COALESCE(ast.status, 'available') AS status, ast.next_free_at
           FROM asset_instances ai
           LEFT JOIN asset_stock ast ON ast.asset_id = ai.asset_id
          WHERE ai.company_id = $1 AND ai.asset_id = $2 AND ai.asset_type = 'nozzle'`,
        [companyId, nozzleAssetId]
      ),
      this.databaseService.query<JobRow>(
        this.jobSelectSql(
          hasStl,
          `WHERE op.company_id = $1
             AND op.assigned_nozzle_asset_id = $2
             AND op.status IN ('scheduled','printing','done','failed')
             AND op.scheduled_start_at < $4
             AND op.scheduled_end_at   > $3`,
          "op.scheduled_start_at ASC",
          true
        ),
        [companyId, nozzleAssetId, query.from, query.to]
      ),
      this.databaseService.query<JobRow>(
        this.jobSelectSql(
          hasStl,
          `WHERE op.company_id = $1
             AND op.assigned_nozzle_asset_id = $2
             AND op.status IN ('assigned','ready')`,
          "o.deadline ASC NULLS LAST, op.created_at ASC",
          true
        ),
        [companyId, nozzleAssetId]
      ),
    ]);
    if (nozzleRes.rowCount === 0) throw new NotFoundException("Nozzle not found.");

    let bedScheduled: Array<JobRow & { is_bed?: boolean }> = [];
    let bedFloating: Array<JobRow & { is_bed?: boolean }> = [];
    if (hasBeds) {
      const [bs, bf] = await Promise.all([
        this.databaseService.query<JobRow & { is_bed?: boolean }>(
          this.bedAsJobSelectSql(
            `WHERE pb.company_id = $1 AND pb.assigned_nozzle_asset_id = $2
               AND pb.status IN ('scheduled','printing','done','failed')
               AND pb.scheduled_start_at < $4 AND pb.scheduled_end_at > $3`,
            "pb.scheduled_start_at ASC",
            true
          ),
          [companyId, nozzleAssetId, query.from, query.to]
        ),
        this.databaseService.query<JobRow & { is_bed?: boolean }>(
          this.bedAsJobSelectSql(
            `WHERE pb.company_id = $1 AND pb.assigned_nozzle_asset_id = $2
               AND pb.status IN ('assigned','ready')`,
            "pb.effective_deadline ASC NULLS LAST, pb.created_at ASC",
            true
          ),
          [companyId, nozzleAssetId]
        ),
      ]);
      bedScheduled = bs.rows;
      bedFloating = bf.rows;
    }

    return {
      nozzle: nozzleRes.rows[0]!,
      scheduled: [...scheduledRes.rows, ...bedScheduled],
      floating: [...floatingRes.rows, ...bedFloating],
    };
  }

  // ──────────────────────────────────────────────────────────
  // SPOOL timeline + depletion ledger. A spool is a physical, time-exclusive
  // object (mounted on one machine at a time), so it gets an interval lane just
  // like printers/nozzles — PLUS a depletion ledger (grams remaining as each
  // job that draws from it consumes its planned grams). Reservations live in
  // order_piece_spools (one job may reserve several spools).
  // ──────────────────────────────────────────────────────────
  async spoolTimeline(companyId: string, spoolAssetId: string, query: TimelineQuery) {
    const hasStl = await this.hasStlColumn();
    const [spoolRes, scheduledRes, ledgerRes] = await Promise.all([
      this.databaseService.query<{
        spool_asset_id: string;
        initial_grams: number | null;
        remaining_grams: number | null;
        reserved_grams: number | null;
        status: string;
        filament_ref_id: string | null;
        filament_label: string | null;
      }>(
        `SELECT ai.asset_id AS spool_asset_id, ai.initial_grams,
                ast.remaining_grams, ast.reserved_grams, COALESCE(ast.status, 'available') AS status,
                ai.filament_ref_id,
                CASE WHEN fr.filament_ref_id IS NOT NULL
                     THEN fr.brand || ' ' || fr.material_type || ' · ' || fr.color
                     ELSE NULL END AS filament_label
           FROM asset_instances ai
           LEFT JOIN asset_stock ast ON ast.asset_id = ai.asset_id
           LEFT JOIN filament_reference fr ON fr.filament_ref_id = ai.filament_ref_id
          WHERE ai.company_id = $1 AND ai.asset_id = $2 AND ai.asset_type = 'filament_spool'`,
        [companyId, spoolAssetId]
      ),
      this.databaseService.query<JobRow>(
        this.jobSelectSql(
          hasStl,
          `WHERE op.company_id = $1
             AND op.piece_id IN (SELECT piece_id FROM order_piece_spools WHERE company_id = $1 AND spool_asset_id = $2)
             AND op.status IN ('scheduled','printing','done','failed')
             AND op.scheduled_start_at < $4
             AND op.scheduled_end_at   > $3`,
          "op.scheduled_start_at ASC",
          true
        ),
        [companyId, spoolAssetId, query.from, query.to]
      ),
      // Full consumption ledger (all reservations, any time) ordered by run
      // time. A bedded piece carries no schedule of its own — its bed does — so
      // we fall back to the bed's name/status/time when the piece is bedded.
      this.databaseService.query<{
        piece_id: string;
        bed_id: string | null;
        piece_name: string;
        planned_grams: string;
        sequence_order: number;
        status: JobStatus;
        scheduled_start_at: string | null;
      }>(
        `SELECT ops.piece_id,
                op.bed_id,
                COALESCE(pb.bed_name, op.piece_name)               AS piece_name,
                ops.planned_grams, ops.sequence_order,
                COALESCE(pb.status, op.status)                     AS status,
                COALESCE(pb.scheduled_start_at, op.scheduled_start_at) AS scheduled_start_at
           FROM order_piece_spools ops
           JOIN order_pieces op ON op.piece_id = ops.piece_id
           LEFT JOIN print_beds pb ON pb.bed_id = op.bed_id
          WHERE ops.company_id = $1 AND ops.spool_asset_id = $2
          ORDER BY COALESCE(pb.scheduled_start_at, op.scheduled_start_at) ASC NULLS LAST, ops.sequence_order ASC`,
        [companyId, spoolAssetId]
      ),
    ]);
    if (spoolRes.rowCount === 0) throw new NotFoundException("Spool not found.");

    // Beds reserve this spool through their child pieces, but the SCHEDULE lives
    // on the bed (the children carry no scheduled_start_at). Surface those beds
    // as blocks so the spool lane isn't empty for a bed that's clearly booked.
    let bedBlocks: Array<JobRow & { is_bed?: boolean }> = [];
    if (await this.hasBedsTable()) {
      const bedsRes = await this.databaseService.query<JobRow & { is_bed?: boolean }>(
        `SELECT pb.bed_id AS piece_id,
                NULL::uuid AS order_id,
                pb.bed_name AS order_reference,
                pb.effective_deadline::text AS order_deadline,
                pb.bed_name AS piece_name,
                pb.description,
                pb.status,
                pb.assigned_printer_id,
                CASE WHEN pi.printer_id IS NOT NULL THEN pi.brand || ' ' || pi.model ELSE NULL END AS assigned_printer_label,
                pb.assigned_nozzle_asset_id,
                pb.required_print_technology,
                pb.required_nozzle_diameter_mm,
                pb.required_nozzle_material,
                pb.required_filament_ref_id,
                pb.required_filament_material,
                NULL::text AS required_filament_label,
                NULL::text AS required_color,
                pb.required_multicolor_capable,
                pb.slicer_print_time_minutes,
                pb.slicer_filament_used_grams,
                pb.slicer_file_url,
                pb.stl_file_url,
                pb.scheduled_start_at,
                pb.scheduled_end_at,
                pb.print_started_at,
                pb.print_completed_at,
                NULL::text AS customer_name,
                TRUE AS is_bed
           FROM print_beds pb
           LEFT JOIN printer_instances pi ON pi.printer_id = pb.assigned_printer_id
          WHERE pb.company_id = $1
            AND pb.status IN ('scheduled','printing','done','failed')
            AND pb.scheduled_start_at < $4
            AND pb.scheduled_end_at   > $3
            AND pb.bed_id IN (
              SELECT op.bed_id FROM order_pieces op
               JOIN order_piece_spools ops ON ops.piece_id = op.piece_id
              WHERE op.company_id = $1 AND ops.spool_asset_id = $2 AND op.bed_id IS NOT NULL
            )`,
        [companyId, spoolAssetId, query.from, query.to]
      );
      bedBlocks = bedsRes.rows;
    }

    // Attach this spool's planned grams to each block for the lane tooltip. Bed
    // grams are the sum of the bed's child reservations on this spool.
    const gramsByPiece = new Map<string, number>();
    const gramsByBed = new Map<string, number>();
    for (const r of ledgerRes.rows) {
      const g = Number(r.planned_grams);
      gramsByPiece.set(r.piece_id, g);
      if (r.bed_id) gramsByBed.set(r.bed_id, (gramsByBed.get(r.bed_id) ?? 0) + g);
    }
    const scheduled = [
      ...scheduledRes.rows.map((r) => ({ ...r, planned_grams: gramsByPiece.get(r.piece_id) ?? null })),
      ...bedBlocks.map((b) => ({ ...b, planned_grams: gramsByBed.get(b.piece_id) ?? null })),
    ];

    return {
      spool: spoolRes.rows[0]!,
      scheduled,
      ledger: ledgerRes.rows.map((r) => ({
        piece_id: r.piece_id,
        piece_name: r.piece_name,
        planned_grams: Number(r.planned_grams),
        sequence_order: r.sequence_order,
        status: r.status,
        scheduled_start_at: r.scheduled_start_at,
      })),
    };
  }

  // ──────────────────────────────────────────────────────────
  // FILAMENT PLAN — for a given piece, which physical spool(s) will feed it.
  //   single        → one compatible spool has enough free grams (best-fit).
  //   combine       → no single spool fits, but ≥2 together do (operator must
  //                   confirm a mid-print spool change).
  //   insufficient  → not enough free filament of the right ref anywhere.
  //   none          → can't plan yet (no filament ref / no grams from slicer).
  // free grams = remaining − reserved. Read-only; the reservation is written at
  // schedule time. This is what the schedule UI renders so the operator sees a
  // job's spool involvement before committing.
  // ──────────────────────────────────────────────────────────
  // The spools ACTUALLY reserved for a piece (rows in order_piece_spools),
  // grouped by color-slot sequence_order. This is the source of truth for
  // "is this reserved?" — distinct from filamentPlanCore.allocation, which is
  // only a *suggested* plan computed from free inventory. Exposed publicly so
  // beds (which anchor their reservation on a child piece) can reuse it.
  async reservedSpoolsBySeq(
    companyId: string,
    pieceId: string,
  ): Promise<Map<number, Array<{ spool_asset_id: string; grams: number; sequence: number }>>> {
    const res = await this.databaseService.query<{
      spool_asset_id: string; planned_grams: string | null; sequence_order: number;
    }>(
      `SELECT spool_asset_id, planned_grams, sequence_order
         FROM order_piece_spools
        WHERE company_id = $1 AND piece_id = $2
        ORDER BY sequence_order`,
      [companyId, pieceId],
    );
    const map = new Map<number, Array<{ spool_asset_id: string; grams: number; sequence: number }>>();
    for (const r of res.rows) {
      const seq = Number(r.sequence_order);
      const list = map.get(seq) ?? [];
      list.push({ spool_asset_id: r.spool_asset_id, grams: Number(r.planned_grams ?? 0), sequence: seq });
      map.set(seq, list);
    }
    return map;
  }

  async filamentPlan(companyId: string, pieceId: string) {
    const piece = await this.loadJob(companyId, pieceId);
    const colorSlots = await this.listColorSlots(companyId, pieceId);
    // Real, committed reservations (order_piece_spools) — the honest signal of
    // whether each slot is reserved, independent of the suggested plan.
    const reservedBySeq = await this.reservedSpoolsBySeq(companyId, pieceId);

    // Multicolor: one plan per color slot, each restricted to that slot's
    // material family AND color, sized to the slot's own slicer demand.
    if (colorSlots.length > 0) {
      const slots = await Promise.all(
        colorSlots.map(async (slot) => {
          const slotNeed = slot.slicer_grams != null ? Number(slot.slicer_grams) : null;
          const plan = await this.filamentPlanCore(
            companyId,
            slot.slot_material,
            slotNeed,
            slot.slot_color
          );
          // plan.needed_grams already carries slotNeed (filamentPlanCore was
          // called with it), so no separate slicer_grams field is needed.
          return {
            sequence_order: slot.sequence_order,
            slot_material: slot.slot_material,
            slot_color: slot.slot_color,
            ...plan,
            reserved_allocation: reservedBySeq.get(slot.sequence_order) ?? [],
          };
        })
      );
      return { multicolor: true as const, slots };
    }

    const plan = await this.filamentPlanCore(
      companyId,
      piece.required_filament_material,
      piece.slicer_filament_used_grams != null ? Number(piece.slicer_filament_used_grams) : null,
      piece.required_color
    );
    // Single-color may reserve several spools (a "combine" plan) under seq 1,2,…
    // — flatten them all into this one slot's reserved set.
    return {
      multicolor: false as const,
      ...plan,
      reserved_allocation: [...reservedBySeq.values()].flat(),
    };
  }

  // Shared planner — also used by beds. Spools are matched to the required
  // MATERIAL by family (PLA covers PLA+, PLA Matte, …), not an exact reference.
  // An optional `color` further restricts matches to that exact color (used by
  // multicolor color slots, where each slot binds a specific material+color).
  async filamentPlanCore(
    companyId: string,
    material: string | null,
    needed: number | null,
    color?: string | null
  ) {
    const base = {
      needed_grams: needed,
      ref_label: material,
      spools: [] as Array<{ spool_asset_id: string; label: string | null; marker: string | null; remaining: number; reserved: number; free: number; status: string }>,
      allocation: [] as Array<{ spool_asset_id: string; label: string | null; grams: number; sequence: number }>,
    };
    if (!material || needed == null || needed <= 0) {
      return { ...base, plan: "none" as const };
    }
    const wantFamily = materialFamily(material);
    const res = await this.databaseService.query<{
      asset_id: string; label: string | null; marker: string | null; material_type: string | null; color: string | null; remaining_grams: string | null; reserved_grams: string | null; status: string;
    }>(
      `SELECT ai.asset_id,
              ai.marker,
              fr.material_type,
              fr.color,
              COALESCE(ast.remaining_grams, ai.initial_grams) AS remaining_grams,
              COALESCE(ast.reserved_grams, 0)                 AS reserved_grams,
              COALESCE(ast.status, 'available')               AS status,
              CASE WHEN fr.filament_ref_id IS NOT NULL
                   THEN fr.brand || ' ' || fr.material_type || ' · ' || fr.color ELSE NULL END AS label
         FROM asset_instances ai
         LEFT JOIN asset_stock ast ON ast.asset_id = ai.asset_id
         LEFT JOIN filament_reference fr ON fr.filament_ref_id = ai.filament_ref_id
        WHERE ai.company_id = $1
          AND ai.asset_type = 'filament_spool'
          AND COALESCE(ast.status, 'available') IN ('available','in_use','installed')`,
      [companyId]
    );
    const spools = res.rows
      .filter((r) => r.material_type != null && materialFamily(r.material_type) === wantFamily)
      .filter((r) => color == null || sameColor(r.color, color))
      .map((r) => {
      const remaining = Number(r.remaining_grams ?? 0);
      const reserved = Number(r.reserved_grams ?? 0);
      return { spool_asset_id: r.asset_id, label: r.label, marker: r.marker, remaining, reserved, status: r.status, free: Math.max(0, remaining - reserved) };
    });
    spools.sort((a, b) => b.free - a.free);

    // Single best-fit: smallest spool that still covers the job (minimises waste).
    const fits = spools.filter((s) => s.free >= needed).sort((a, b) => a.free - b.free);
    if (fits.length > 0) {
      const s = fits[0]!;
      return { ...base, spools, plan: "single" as const, allocation: [{ spool_asset_id: s.spool_asset_id, label: s.label, grams: needed, sequence: 1 }] };
    }
    const totalFree = spools.reduce((sum, s) => sum + s.free, 0);
    if (totalFree >= needed) {
      // Combine: greedily draw from the largest spools first.
      const allocation: typeof base.allocation = [];
      let remaining = needed;
      let seq = 1;
      for (const s of spools) {
        if (remaining <= 0) break;
        const take = Math.min(s.free, remaining);
        if (take > 0) {
          allocation.push({ spool_asset_id: s.spool_asset_id, label: s.label, grams: Math.round(take * 100) / 100, sequence: seq++ });
          remaining -= take;
        }
      }
      return { ...base, spools, plan: "combine" as const, allocation };
    }
    return { ...base, spools, plan: "insufficient" as const };
  }

  // ──────────────────────────────────────────────────────────
  // RESERVE physical spool instance(s) for a piece — binds spools + reserves
  // their grams (asset_stock.reserved_grams). Transactional. If no explicit
  // allocation is given, auto-plans (single best-fit, else combine). Re-reserving
  // first releases any prior reservation for the piece.
  // ──────────────────────────────────────────────────────────
  async reserveSpools(companyId: string, pieceId: string, input: ReserveSpoolsInput): Promise<JobRow> {
    const piece = await this.loadJob(companyId, pieceId);
    if (!piece.required_filament_material) {
      throw new BadRequestException("Set a filament material before reserving a spool.");
    }
    const needed = piece.slicer_filament_used_grams != null ? Number(piece.slicer_filament_used_grams) : null;
    if (needed == null || needed <= 0) {
      throw new BadRequestException("Upload a slicer file first — filament grams are needed to reserve a spool.");
    }
    if (piece.status === "scheduled" || piece.status === "printing" || piece.status === "done" || piece.status === "failed") {
      throw new ConflictException(`Cannot change the spool reservation on a '${piece.status}' piece. Unschedule first.`);
    }

    const colorSlots = await this.listColorSlots(companyId, pieceId);

    // Multicolor: one (or more) spool per color slot, each matched to its slot
    // by sequence_order and validated against that slot's material + color.
    if (colorSlots.length > 0) {
      return this.reserveSpoolsMulticolor(companyId, pieceId, colorSlots, needed, input);
    }

    const wantFamily = materialFamily(piece.required_filament_material);

    // Resolve allocations: explicit, or auto-planned.
    let allocations: Array<{ spool_asset_id: string; grams: number }> = input.allocations ?? [];
    if (allocations.length === 0) {
      const plan = await this.filamentPlanCore(companyId, piece.required_filament_material, needed);
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
      await this.releaseSpoolsTx(client, companyId, pieceId);
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
          throw new BadRequestException(`A chosen spool's material (${s.material_type ?? "unknown"}) doesn't match the piece's material (${piece.required_filament_material}).`);
        }
        if (s.status === "empty" || s.status === "damaged") throw new BadRequestException(`A chosen spool is ${s.status}.`);
        const free = Math.max(0, Number(s.remaining ?? 0) - Number(s.reserved ?? 0));
        if (a.grams - 0.001 > free) throw new BadRequestException(`A chosen spool has only ${Math.round(free)}g free (needs ${Math.round(a.grams)}g).`);

        await client.query(
          `INSERT INTO order_piece_spools (company_id, piece_id, spool_asset_id, planned_grams, sequence_order)
           VALUES ($1, $2, $3, $4, $5)`,
          [companyId, pieceId, a.spool_asset_id, a.grams, seq++]
        );
        // reserved_grams is recalculated by the DB trigger
        // fn_recalc_reserved_grams_for_spool on this INSERT — the trigger is the
        // sole writer of that column, so no manual increment here.
      }
    });
    return this.loadJob(companyId, pieceId);
  }

  /**
   * Multicolor reservation: each allocation carries the sequence_order of the
   * color slot it fills. The spool's material family + color must match that
   * slot, every slot must be covered, and the reserved grams per slot must meet
   * the slot's slicer demand. Spools insert with the slot's sequence_order so
   * the slot↔spool link survives in order_piece_spools.
   */
  private async reserveSpoolsMulticolor(
    companyId: string,
    pieceId: string,
    colorSlots: ColorSlotRow[],
    needed: number,
    input: ReserveSpoolsInput
  ): Promise<JobRow> {
    const allocations = input.allocations ?? [];
    if (allocations.length === 0) {
      throw new BadRequestException("Multicolor pieces need an explicit spool per color slot.");
    }
    if (allocations.some((a) => a.sequence_order == null)) {
      throw new BadRequestException("Each multicolor allocation must name its color slot (sequence_order).");
    }

    const slotsBySeq = new Map<number, ColorSlotRow>(colorSlots.map((s) => [s.sequence_order, s]));

    // Every color slot must receive enough filament.
    const gramsBySeq = new Map<number, number>();
    for (const a of allocations) {
      const seq = a.sequence_order!;
      if (!slotsBySeq.has(seq)) {
        throw new BadRequestException(`No color slot ${seq} on this piece.`);
      }
      gramsBySeq.set(seq, (gramsBySeq.get(seq) ?? 0) + a.grams);
    }
    for (const slot of colorSlots) {
      const allocated = gramsBySeq.get(slot.sequence_order) ?? 0;
      if (allocated <= 0) {
        throw new BadRequestException(`Color slot ${slot.sequence_order} (${slot.slot_material} · ${slot.slot_color}) has no spool reserved.`);
      }
      const slotNeed = slot.slicer_grams != null ? Number(slot.slicer_grams) : 0;
      if (slotNeed > 0 && allocated + 0.001 < slotNeed) {
        throw new BadRequestException(`Color slot ${slot.sequence_order} needs ${Math.round(slotNeed)}g but only ${Math.round(allocated)}g is reserved.`);
      }
    }
    const totalAllocated = allocations.reduce((s, a) => s + a.grams, 0);
    if (totalAllocated + 0.001 < needed) {
      throw new BadRequestException(`Allocated ${Math.round(totalAllocated)}g is less than the ${Math.round(needed)}g needed.`);
    }

    // Two slots may legitimately share a material+color (e.g. two different
    // blue spools), but a single physical spool can't fill two slots at once —
    // order_piece_spools.uq_piece_spool_asset would reject it. Catch it here
    // with a clear message instead of surfacing a raw constraint violation.
    const seenSpools = new Set<string>();
    for (const a of allocations) {
      if (seenSpools.has(a.spool_asset_id)) {
        throw new BadRequestException("The same spool can't be assigned to more than one color slot — pick a separate spool per slot.");
      }
      seenSpools.add(a.spool_asset_id);
    }

    await this.databaseService.transaction(async (client) => {
      await this.releaseSpoolsTx(client, companyId, pieceId);
      for (const a of allocations) {
        const slot = slotsBySeq.get(a.sequence_order!)!;
        const spoolRes = await client.query<{
          remaining: string | null; reserved: string | null; material_type: string | null; color: string | null; type: string; status: string;
        }>(
          `SELECT COALESCE(ast.remaining_grams, ai.initial_grams) AS remaining,
                  COALESCE(ast.reserved_grams, 0) AS reserved,
                  fr.material_type, fr.color, ai.asset_type AS type,
                  COALESCE(ast.status, 'available') AS status
             FROM asset_instances ai
             LEFT JOIN asset_stock ast ON ast.asset_id = ai.asset_id
             LEFT JOIN filament_reference fr ON fr.filament_ref_id = ai.filament_ref_id
            WHERE ai.company_id = $1 AND ai.asset_id = $2`,
          [companyId, a.spool_asset_id]
        );
        const s = spoolRes.rows[0];
        if (!s || s.type !== "filament_spool") throw new BadRequestException("Selected spool not found.");
        if (!s.material_type || materialFamily(s.material_type) !== materialFamily(slot.slot_material)) {
          throw new BadRequestException(`Spool material (${s.material_type ?? "unknown"}) doesn't match color slot ${slot.sequence_order} (${slot.slot_material}).`);
        }
        if (!sameColor(s.color, slot.slot_color)) {
          throw new BadRequestException(`Spool color (${s.color ?? "unknown"}) doesn't match color slot ${slot.sequence_order} (${slot.slot_color}).`);
        }
        if (s.status === "empty" || s.status === "damaged") throw new BadRequestException(`A chosen spool is ${s.status}.`);
        const free = Math.max(0, Number(s.remaining ?? 0) - Number(s.reserved ?? 0));
        if (a.grams - 0.001 > free) throw new BadRequestException(`A chosen spool has only ${Math.round(free)}g free (needs ${Math.round(a.grams)}g).`);

        await client.query(
          `INSERT INTO order_piece_spools (company_id, piece_id, spool_asset_id, planned_grams, sequence_order)
           VALUES ($1, $2, $3, $4, $5)`,
          [companyId, pieceId, a.spool_asset_id, a.grams, a.sequence_order!]
        );
        // reserved_grams is recalculated by the DB trigger
        // fn_recalc_reserved_grams_for_spool on this INSERT — the trigger is the
        // sole writer of that column, so no manual increment here.
      }
    });
    return this.loadJob(companyId, pieceId);
  }

  /** Distinct slot materials for a piece (multicolor); empty for single-color. */
  private async listColorSlotMaterials(companyId: string, pieceId: string): Promise<string[]> {
    const res = await this.databaseService.query<{ slot_material: string }>(
      `SELECT DISTINCT slot_material FROM order_piece_color_slots WHERE company_id = $1 AND piece_id = $2`,
      [companyId, pieceId]
    );
    return res.rows.map((r) => r.slot_material);
  }

  /** Full color-slot rows for a piece, ordered by sequence. */
  private async listColorSlots(companyId: string, pieceId: string): Promise<ColorSlotRow[]> {
    const res = await this.databaseService.query<ColorSlotRow>(
      `SELECT color_slot_id, sequence_order, slot_material, slot_color, slicer_grams
         FROM order_piece_color_slots
        WHERE company_id = $1 AND piece_id = $2
        ORDER BY sequence_order ASC`,
      [companyId, pieceId]
    );
    return res.rows;
  }

  /** Release a piece's spool reservation (give the reserved grams back). */
  async releaseSpools(companyId: string, pieceId: string): Promise<JobRow> {
    await this.databaseService.transaction(async (client) => {
      await this.releaseSpoolsTx(client, companyId, pieceId);
    });
    return this.loadJob(companyId, pieceId);
  }

  /** Transactional helper: drop reservations + return reserved grams. */
  private async releaseSpoolsTx(client: import("pg").PoolClient, companyId: string, pieceId: string): Promise<void> {
    // Deleting the order_piece_spools rows fires fn_recalc_reserved_grams_for_spool,
    // which recomputes reserved_grams for each affected spool — the trigger is the
    // sole writer of that column, so no manual decrement here.
    await client.query(`DELETE FROM order_piece_spools WHERE company_id = $1 AND piece_id = $2`, [companyId, pieceId]);
  }

  /** Consume reserved filament on completion: reserved → deducted from remaining. */
  private async consumeSpoolsTx(client: import("pg").PoolClient, companyId: string, pieceId: string): Promise<void> {
    const rows = await client.query<{ spool_asset_id: string; planned_grams: string }>(
      `SELECT spool_asset_id, planned_grams FROM order_piece_spools WHERE company_id = $1 AND piece_id = $2`,
      [companyId, pieceId]
    );
    for (const r of rows.rows) {
      const g = Number(r.planned_grams);
      // reserved_grams is owned by fn_recalc_reserved_grams_for_spool (the
      // piece's status flip to done/failed already fired it); here we only
      // deduct the physically consumed grams and flag an emptied spool.
      await client.query(
        `UPDATE asset_stock
            SET remaining_grams = GREATEST(0, COALESCE(remaining_grams, 0) - $2),
                status = CASE WHEN GREATEST(0, COALESCE(remaining_grams,0) - $2) <= 0 THEN 'empty' ELSE status END
          WHERE asset_id = $1`,
        [r.spool_asset_id, g]
      );
    }
  }

  async timeline(companyId: string, query: TimelineQuery) {
    const hasStl = await this.hasStlColumn();
    const [printersRes, scheduledRes, floatingRes] = await Promise.all([
      this.databaseService.query<{
        printer_id: string;
        brand: string;
        model: string;
        serial_number: string | null;
        location: string | null;
        is_under_maintenance: boolean;
        is_offline: boolean;
      }>(
        `SELECT pi.printer_id, pi.brand, pi.model, pi.serial_number, pi.location,
                COALESCE(ps.is_under_maintenance, FALSE) AS is_under_maintenance,
                COALESCE(ps.is_offline, FALSE) AS is_offline
           FROM printer_instances pi
           LEFT JOIN printer_stock ps ON ps.printer_id = pi.printer_id
          WHERE pi.company_id = $1
          ORDER BY pi.brand, pi.model`,
        [companyId]
      ),
      this.databaseService.query<JobRow>(
        this.jobSelectSql(
          hasStl,
          `WHERE op.company_id = $1
             AND op.status IN ('scheduled','printing','done','failed')
             AND op.scheduled_start_at < $3
             AND op.scheduled_end_at   > $2`,
          "op.scheduled_start_at ASC",
          true
        ),
        [companyId, query.from, query.to]
      ),
      this.databaseService.query<JobRow>(
        this.jobSelectSql(
          hasStl,
          // Both 'assigned' and 'ready' are unscheduled — they belong in the
          // click-to-place bucket.
          `WHERE op.company_id = $1 AND op.status IN ('assigned','ready')`,
          "o.deadline ASC NULLS LAST, op.created_at ASC",
          true
        ),
        [companyId]
      ),
    ]);

    // Scheduled BEDS occupy printers too — surface them as timeline blocks so
    // the operator sees the complete picture. Shaped like JobRow with an
    // `is_bed` marker + the bed_id under piece_id so the UI can route a click
    // to the bed detail.
    let bedBlocks: Array<JobRow & { is_bed?: boolean }> = [];
    if (await this.hasBedsTable()) {
      const bedsRes = await this.databaseService.query<JobRow & { is_bed?: boolean }>(
        `SELECT pb.bed_id AS piece_id,
                NULL::uuid AS order_id,
                pb.bed_name AS order_reference,
                pb.effective_deadline::text AS order_deadline,
                pb.bed_name AS piece_name,
                pb.description,
                pb.status,
                pb.assigned_printer_id,
                CASE WHEN pi.printer_id IS NOT NULL THEN pi.brand || ' ' || pi.model ELSE NULL END AS assigned_printer_label,
                pb.assigned_nozzle_asset_id,
                pb.required_print_technology,
                pb.required_nozzle_diameter_mm,
                pb.required_nozzle_material,
                pb.required_filament_ref_id,
                pb.required_filament_material,
                NULL::text AS required_filament_label,
                NULL::text AS required_color,
                pb.required_multicolor_capable,
                pb.slicer_print_time_minutes,
                pb.slicer_filament_used_grams,
                pb.slicer_file_url,
                pb.stl_file_url,
                pb.scheduled_start_at,
                pb.scheduled_end_at,
                pb.print_started_at,
                pb.print_completed_at,
                NULL::text AS customer_name,
                TRUE AS is_bed
           FROM print_beds pb
           LEFT JOIN printer_instances pi ON pi.printer_id = pb.assigned_printer_id
          WHERE pb.company_id = $1
            AND pb.status IN ('scheduled','printing','done','failed')
            AND pb.scheduled_start_at < $3
            AND pb.scheduled_end_at   > $2`,
        [companyId, query.from, query.to]
      );
      bedBlocks = bedsRes.rows;
    }

    // Which physical spool(s) each block reserves — so the timeline can pivot
    // by literal inventory spool, not just material family.
    const spoolsByBlock = await this.spoolIdsByBlock(
      companyId,
      scheduledRes.rows.map((r) => r.piece_id),
      bedBlocks.map((b) => b.piece_id)
    );
    const withSpools = (rows: Array<JobRow & { is_bed?: boolean }>) =>
      rows.map((b) => ({ ...b, spool_asset_ids: spoolsByBlock.get(b.piece_id) ?? [] }));

    return {
      printers: printersRes.rows,
      scheduled: [...withSpools(scheduledRes.rows), ...withSpools(bedBlocks)],
      floating: floatingRes.rows,
    };
  }
}
