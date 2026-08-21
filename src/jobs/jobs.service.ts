import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { QueryResult, QueryResultRow } from "pg";
import { DatabaseService } from "../database/database.service";
import { compareSpoolPreference, bestSingleSpool, combineOrder } from "../common/spool-choice";
import {
  reevaluateBedAfterPieceRemoval,
  recomputeOrderStatusTx,
  markPrinterPrintingTx,
  propagateSlicerMetaToDuplicatesTx,
  releasePrinterForPieceTx
} from "../common/cascade";
import type {
  AssignJobInput,
  CompleteJobInput,
  FindCandidatesInput,
  JobStatus,
  ListJobsQuery,
  QueueSortQuery,
  QueueSortKey,
  ReserveSpoolsInput,
  RestoreJobInput,
  ScheduleJobInput,
  TimeHorizon,
  TimelineQuery,
  UpdatePieceFilesInput,
} from "./jobs.schemas";
import { JOB_STATUSES } from "./jobs.schemas";
// The scheduling kernel — pure, no Nest, no database. The rule for "are these
// two nozzles the same thing as far as the machine is concerned?" lives there
// because the auto-packer already needed it; a manual drop asking the same
// question must get the same answer, so it asks the same function rather than
// re-deriving one that could drift.
import { chooseInterchangeableNozzle, nozzleSpecOf, type NozzleOption } from "../simple-jobs/packing";
// SQL + folding for the nozzle pools, kept in a pure module so a test can
// execute the statements. See the header there.
import {
  foldNozzlePools,
  nozzleBusyProbeSql,
  nozzleIdentityLabel,
  nozzlePoolSql,
  nozzleRosterSql,
  type NozzlePoolRow,
} from "./nozzle-pool";
export type { NozzlePool, NozzlePoolMember, NozzleSwitch } from "./nozzle-pool";
import type { NozzleSwitch } from "./nozzle-pool";

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
// The pure compatibility rules now live in matching.ts (sibling of packing.ts)
// so they can be unit-tested — this file's Nest constructor parameter properties
// make it unloadable by the test runner's strip-only TypeScript loader.
// Imported for use below AND re-exported, so every existing
// `from "../jobs/jobs.service"` import site keeps working unchanged.
import {
  materialFamily,
  materialsCompatible,
  isResinTech,
  techFamily,
  techCompatible,
  sameColor,
  colorCompatible,
  pickTank,
  type TankChoice,
} from "./matching";

export {
  materialFamily,
  materialsCompatible,
  isResinTech,
  techFamily,
  techCompatible,
  sameColor,
  colorCompatible,
  pickTank,
  type TankChoice,
};

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
  // Human-set order title (orders.title), shown next to the number in the Jobs
  // queue's per-order header. Empty/null for untitled orders.
  order_title: string | null;
  order_deadline: string;
  piece_name: string;
  description: string | null;
  status: JobStatus;
  assigned_printer_id: string | null;
  assigned_printer_label: string | null;
  assigned_printer_technology: string | null;
  assigned_printer_marker: string | null;
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
  // ── Resin (MSLA/SLA) ──────────────────────────────────────────────────────
  // The tank feeding this job + the slicer's volume estimate in millilitres.
  // Both null on FDM pieces and on bed rows.
  resin_tank_id?: string | null;
  slicer_resin_used_ml?: number | string | null;
  resin_tank_label?: string | null;
  // Post-processing lifecycle, orthogonal to `status` (the piece stays 'done'):
  // print_done → washed → cured. Null on anything that isn't a resin print.
  post_process_state?: string | null;
  post_process_state_entered_at?: string | null;
  // STL (or 3MF mesh) — source 3D model. Tracked independently from the
  // slicer file. Nullable until the operator uploads one.
  stl_file_url: string | null;
  // Small PNG preview rendered from the STL (generated client-side, cached in
  // order_pieces.stl_thumbnail_url). Projected on the queue + single-row reads;
  // NULL until the migration is applied or a thumbnail has been generated.
  stl_thumbnail_url?: string | null;
  scheduled_at: string | null;
  scheduled_start_at: string | null;
  scheduled_end_at: string | null;
  print_started_at: string | null;
  print_completed_at: string | null;
  created_at: string;
  last_updated_at: string;
  customer_name: string | null;
  // Per-piece cost (NUMERIC → string). Optional: beds and some internal
  // JobRow builders don't carry it. Null when the piece isn't priced yet.
  cost?: string | null;
  // The piece's order profit margin (%), so the Jobs list can show price = cost × (1 + %).
  order_profit_pct?: string | null;
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

  // Same TTL-cache pattern for the optional stl_thumbnail_url column
  // (migration 2026-07-04_piece_stl_thumbnail.sql). Until it's applied we
  // project NULL under the alias so the queue keeps working.
  private stlThumbColumnAvailable: boolean | null = null;
  private stlThumbCheckedAt = 0;
  private async hasStlThumbnailColumn(): Promise<boolean> {
    if (
      this.stlThumbColumnAvailable !== null &&
      Date.now() - this.stlThumbCheckedAt < JobsService.STL_CACHE_TTL_MS
    ) {
      return this.stlThumbColumnAvailable;
    }
    const probe = await this.databaseService.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM information_schema.columns
          WHERE table_name = 'order_pieces' AND column_name = 'stl_thumbnail_url'
       ) AS exists`
    );
    this.stlThumbColumnAvailable = !!probe.rows[0]?.exists;
    this.stlThumbCheckedAt = Date.now();
    return this.stlThumbColumnAvailable;
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
    const hasThumb = await this.hasStlThumbnailColumn();
    const result = await this.databaseService.query<JobRow>(
      this.jobSelectSql(
        hasStl,
        "WHERE op.company_id = $1 AND op.piece_id = $2",
        "op.created_at DESC",
        false,
        hasThumb
      ),
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
    excludeDraftOrders = false,
    hasThumb = false
  ): string {
    const stlProjection = hasStl ? "op.stl_file_url" : "NULL::text AS stl_file_url";
    const thumbProjection = hasThumb
      ? "op.stl_thumbnail_url"
      : "NULL::text AS stl_thumbnail_url";
    const orderStatusClause = excludeDraftOrders
      ? `AND o.status IN ('confirmed','in_progress','completed','ready_for_shipping','out_for_shipping')`
      : "";
    return `
      SELECT
        op.piece_id,
        op.order_id,
        o.order_number AS order_reference,
        o.title AS order_title,
        o.deadline::text AS order_deadline,
        op.piece_name,
        op.description,
        op.status,
        op.fulfilment_status,
        op.assigned_printer_id,
        CASE
          WHEN pi.printer_id IS NOT NULL THEN pi.brand || ' ' || pi.model
          ELSE NULL
        END AS assigned_printer_label,
        -- The assigned machine's OWN identity, alongside its label. Distinct
        -- from op.required_print_technology below: that is what the piece asks
        -- for, this is what the box actually is. They must agree once assigned,
        -- and showing the machine's own value is what makes a disagreement
        -- visible instead of assumed.
        pi.print_technology AS assigned_printer_technology,
        pi.marker           AS assigned_printer_marker,
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
        -- ── Resin (MSLA/SLA) ──────────────────────────────────────────────
        op.resin_tank_id,
        op.slicer_resin_used_ml,
        -- Post-processing: orthogonal to status, exactly like
        -- fulfilment_status. NULL on every FDM piece.
        op.post_process_state,
        op.post_process_state_entered_at,
        CASE
          WHEN rt.asset_id IS NOT NULL
            THEN NULLIF(TRIM(CONCAT_WS(' ', rt.resin_brand, rt.resin_type, rt.resin_color)), '')
          ELSE NULL
        END AS resin_tank_label,
        op.cost,
        -- Quote inputs (time minutes + per-slot grams) captured while costing
        -- the piece — the client uses them as ASSUMED slicer values until a
        -- sliced file or manual entry overrides them.
        op.cost_inputs,
        o.profit_pct AS order_profit_pct,
        ${stlProjection},
        ${thumbProjection},
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
      LEFT JOIN asset_instances rt    ON rt.asset_id = op.resin_tank_id
      ${whereClause}
      ${orderStatusClause}
      ORDER BY ${orderBy}
    `;
  }

  // ──────────────────────────────────────────────────────────
  // GET /api/jobs/queue
  // ──────────────────────────────────────────────────────────
  /**
   * The queue's WHERE clause, built ONCE and shared by every endpoint that has
   * to agree about which pieces "the queue" currently means.
   *
   * This is not tidiness. Ctrl+A selects ids from one endpoint and the operator
   * then bulk-deletes them; the facet dropdowns come from another; the list they
   * are looking at comes from a third. If any two of those built their filters
   * separately, a select-all could return an id the operator cannot see — and
   * then delete it. One builder makes that class of bug impossible rather than
   * merely unlikely.
   *
   * The `AND o.status IN (...)` draft-order exclusion is NOT here: it lives in
   * jobSelectSql behind its `excludeDraftOrders` flag, so callers of this helper
   * must apply it themselves. See `queueScopeOrderClause`.
   */
  private async buildQueueFilter(
    companyId: string,
    query: ListJobsQuery
  ): Promise<{ wheres: string[]; values: unknown[] }> {
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

    // ── The Filter popover's four fields. Each mirrors the client predicate in
    //    JobsWorkspace's `queueMatchesFilter` EXACTLY, including its quirks:
    //    equality on the rendered strings, and undated pieces surviving a
    //    deadline cut-off because the client only compares when a deadline is
    //    present. Any divergence here shows up as a select-all that disagrees
    //    with the visible list.
    if (query.order_reference) {
      values.push(query.order_reference);
      wheres.push(`o.order_number = $${values.length}`);
    }
    if (query.customer_name) {
      values.push(query.customer_name);
      // Same COALESCE the row projection uses, so the value compared is the one
      // the operator actually picked out of the dropdown.
      wheres.push(
        `COALESCE(
           NULLIF(cu.business_name, ''),
           NULLIF(TRIM(CONCAT_WS(' ', cu.first_name, cu.last_name)), '')
         ) = $${values.length}`
      );
    }
    if (query.technology) {
      values.push(query.technology);
      wheres.push(`op.required_print_technology = $${values.length}`);
    }
    if (query.deadline_by) {
      values.push(query.deadline_by);
      wheres.push(`(o.deadline IS NULL OR o.deadline <= $${values.length}::date)`);
    }

    // Pieces that are part of a bed are hidden — the bed itself shows in
    // their place at the queue level. We only add this filter once the
    // `bed_id` column exists; otherwise we'd break the queue for users
    // who haven't run the print_beds migration yet.
    if (await this.hasBedColumn()) {
      wheres.push(`op.bed_id IS NULL`);
    }
    return { wheres, values };
  }

  /** The draft-order exclusion jobSelectSql applies when excludeDraftOrders is
   *  set. Repeated here verbatim so the aggregate endpoints scope to the same
   *  orders the list does. */
  private static readonly QUEUE_ORDER_STATUSES =
    "('confirmed','in_progress','completed','ready_for_shipping','out_for_shipping')";

  /**
   * The queue's ORDER BY, mirroring the client comparator this replaces.
   *
   * ── HOW THE CLIENT ORDERED, EXACTLY ─────────────────────────────────────────
   * `sortValue()` produced a key, the rows were compared with JS `<` / `>`, ties
   * were broken by `piece_name.localeCompare()` — ALWAYS ascending, even under a
   * descending sort — and Array.prototype.sort being stable left equal rows in
   * arrival order, which was `created_at DESC`. All three layers are reproduced
   * below, including the always-ascending tie-break.
   *
   * ── NULLS ───────────────────────────────────────────────────────────────────
   * Every sentinel the client used for a missing value — `"￿"` for text,
   * `+Infinity` for numbers, `"9999-12-31"` for a missing deadline — sorts a null
   * as the MAXIMUM. Postgres already does exactly that by default (NULLS LAST on
   * ASC, NULLS FIRST on DESC), so no explicit NULLS clause is needed or wanted.
   *
   * ── COLLATION ───────────────────────────────────────────────────────────────
   * Text keys use `lower(x) COLLATE "C"` with `x COLLATE "C" DESC` beneath.
   * Measured against the client's actual comparator: identical on every
   * alphanumeric name, 0.9% divergence overall, confined to pairs where
   * punctuation meets a digit (ICU treats punctuation as ignorable, byte order
   * does not). `COLLATE "C"` is deliberate — it is a built-in that behaves
   * identically on every server, whereas the database's default collation is an
   * environment fact this code cannot see and must not depend on. The DESC on the
   * raw value reproduces ICU's lowercase-before-uppercase tertiary rule; without
   * it, ordering flips for every mixed-case pair.
   *
   * ── TIME ────────────────────────────────────────────────────────────────────
   * `deadline` is a DATE, and the client parses its `YYYY-MM-DD` text through
   * `new Date(...)`, which the language specifies as UTC midnight. So the epoch
   * here is taken `AT TIME ZONE 'UTC'`; reading it in the server's local zone
   * would shift every urgency bucket by the server's offset.
   *
   * Keys are looked up in a fixed table and never interpolated from input.
   */
  private queueOrderBy(sort: QueueSortKey | undefined, order: "asc" | "desc" | undefined): string {
    const dir = order === "desc" ? "DESC" : "ASC";
    // ALWAYS ascending, whatever the primary direction — the client's tie-break
    // is a bare `piece_name.localeCompare(...)` with no direction applied.
    //
    // The second term is where CASE is decided, and it belongs here rather than
    // on the sorted column. The client's primary comparison is over
    // `value.toLowerCase()`, so two rows differing only in case TIE on the
    // primary and fall through to this tie-break every time. Putting a case
    // tertiary on the sorted column instead made "sort by customer" order
    // "Acme" and "acme" against each other, when the client orders them by piece
    // name. `DESC` on the raw bytes reproduces ICU's lowercase-before-uppercase
    // rule (b=0x62 > B=0x42, so descending yields lowercase first).
    const tie = `lower(op.piece_name) COLLATE "C" ASC, op.piece_name COLLATE "C" DESC`;
    // Last resort, so the total order is deterministic even for identical names.
    // Matches the arrival order the client's stable sort preserved.
    const stable = `op.created_at DESC, op.piece_id ASC`;

    // Case-insensitive only. Case is settled by `tie` above, for every key.
    const text = (col: string) => `lower(${col}) COLLATE "C" ${dir}`;

    // bucket * 10^13 + deadline_ms * 10 + status_weight, exactly as
    // urgencySortValue() computes it. Well inside float8's exact-integer range
    // (~9.0e15); the largest term here is ~4.7e13.
    const urgencyExpr = `
      (CASE
         WHEN o.deadline IS NULL THEN NULL
         ELSE
           (CASE
              WHEN (EXTRACT(EPOCH FROM (o.deadline::timestamp AT TIME ZONE 'UTC')) * 1000
                    - EXTRACT(EPOCH FROM now()) * 1000) / 60000.0 < 0        THEN 0
              WHEN (EXTRACT(EPOCH FROM (o.deadline::timestamp AT TIME ZONE 'UTC')) * 1000
                    - EXTRACT(EPOCH FROM now()) * 1000) / 60000.0 <= 1440    THEN 1
              WHEN (EXTRACT(EPOCH FROM (o.deadline::timestamp AT TIME ZONE 'UTC')) * 1000
                    - EXTRACT(EPOCH FROM now()) * 1000) / 60000.0 <= 4320    THEN 2
              ELSE 3
            END) * 10000000000000::float8
           + EXTRACT(EPOCH FROM (o.deadline::timestamp AT TIME ZONE 'UTC')) * 1000 * 10
           + CASE op.status
               WHEN 'printing' THEN 0 WHEN 'scheduled' THEN 1 WHEN 'ready'  THEN 2
               WHEN 'assigned' THEN 3 WHEN 'pending'   THEN 4 WHEN 'failed' THEN 5
               WHEN 'done'     THEN 6 WHEN 'cancelled' THEN 7 ELSE 8
             END
       END)`;

    const statusWeight = `CASE op.status
        WHEN 'pending' THEN 0 WHEN 'assigned'  THEN 1 WHEN 'ready'  THEN 2
        WHEN 'scheduled' THEN 3 WHEN 'printing' THEN 4 WHEN 'done'  THEN 5
        WHEN 'failed'  THEN 6 WHEN 'cancelled' THEN 7 ELSE 8
      END`;

    switch (sort) {
      // The wash/cure bucket overrides the operator's sort entirely with
      // longest-waiting-first, and applies NO tie-break — matching the client's
      // separate early-return branch rather than its general comparator.
      case "post_process_wait":
        return `op.post_process_state_entered_at ASC, ${stable}`;
      case "urgency":     return `${urgencyExpr} ${dir}, ${tie}, ${stable}`;
      case "deadline":    return `o.deadline ${dir}, ${tie}, ${stable}`;
      case "order":       return `${text("o.order_number")}, ${tie}, ${stable}`;
      // Takes the tie-break too: its first term is a no-op against an equal
      // primary, and its second term is what applies the case rule.
      case "piece_name":  return `${text("op.piece_name")}, ${tie}, ${stable}`;
      case "customer":    return `${text(
        `COALESCE(NULLIF(cu.business_name, ''), NULLIF(TRIM(CONCAT_WS(' ', cu.first_name, cu.last_name)), ''))`
      )}, ${tie}, ${stable}`;
      case "status":      return `${statusWeight} ${dir}, ${tie}, ${stable}`;
      case "printer":     return `${text(
        `CASE WHEN pi.printer_id IS NOT NULL THEN pi.brand || ' ' || pi.model ELSE NULL END`
      )}, ${tie}, ${stable}`;
      case "time":        return `op.slicer_print_time_minutes ${dir}, ${tie}, ${stable}`;
      default:            return `op.created_at DESC, op.piece_id ASC`;
    }
  }

  async listJobs(companyId: string, query: QueueSortQuery): Promise<JobRow[]> {
    const { wheres, values } = await this.buildQueueFilter(companyId, query);
    const hasStl = await this.hasStlColumn();
    const hasThumb = await this.hasStlThumbnailColumn();
    // Ordering is the server's job now. Omitting `sort` keeps the historical
    // `created_at DESC`, so a caller that hasn't been updated — or a client
    // deployed ahead of this API — gets exactly what it got before.
    const orderBy = this.queueOrderBy(query.sort, query.order);
    const sql = this.jobSelectSql(hasStl, `WHERE ${wheres.join(" AND ")}`, orderBy, true, hasThumb);
    const result = await this.databaseService.query<JobRow>(sql, values);
    return result.rows;
  }

  // ──────────────────────────────────────────────────────────
  // GET /api/jobs/queue/fingerprint
  // ──────────────────────────────────────────────────────────
  /**
   * A ~70-byte answer to "has the board changed?", so the polling backstop stops
   * pulling the whole queue every 60 seconds. On a 10k-piece tenant that poll is
   * a 16.5 MB response per open tab per minute, almost always byte-identical to
   * the one before it.
   *
   * WHY A CHECKSUM OF THE RENDERED FIELDS, rather than `max(last_updated_at)`.
   *
   * The original reasoning here was WRONG and is corrected in place rather than
   * quietly deleted, because the wrong version is a tempting conclusion to reach
   * again. It said `last_updated_at` is not maintained, on the evidence that
   * none of the 25 `UPDATE order_pieces` statements in this codebase set it —
   * true — and that TimeStateService's four transition updates therefore leave it
   * stale. That last step does not follow. The database maintains the column with
   * a trigger defined in the base schema, not in migrations/:
   *     trg_order_pieces_updated -> fn_order_pieces_set_updated
   * (and trg_orders_updated on orders). Verified against the live database.
   *
   * So the checksum is no longer the ONLY correct option — but it stays, for two
   * reasons. It is correct by construction: it hashes exactly the columns the
   * queue renders, so if what an operator sees would differ, the signature
   * differs, with no dependency on trigger coverage. And it is verified working
   * against real data (a one-piece status change does move the digest).
   *
   * A `count(*) + max(last_updated_at)` fingerprint would be cheaper — an
   * index-assisted aggregate instead of a scan plus string_agg plus md5 — and is
   * worth taking when the 10k tenant makes that difference matter. It needs three
   * things confirmed first, none of which is established yet:
   *   1. `pg_get_triggerdef(trg_order_pieces_updated)` fires on ALL updates, not
   *      `UPDATE OF <column list>` — a status-only write must bump it.
   *   2. An equivalent trigger exists on print_beds, which this also hashes.
   *   3. Nothing writes to these tables in a way that bypasses the trigger.
   * Swapping a verified mechanism for an unverified one to save milliseconds at a
   * scale that does not exist yet would be the wrong trade.
   *
   * DELIBERATELY OVER-SENSITIVE. Pieces are hashed WITHOUT the `bed_id IS NULL`
   * filter the queue itself applies, because a bed's rendered fulfilment and
   * post-process state are rolled up from its child pieces — and those children
   * are exactly what that filter hides. Scoping the hash to the visible set
   * would have made a bedded piece advancing invisible to both halves of this
   * fingerprint. An extra refetch costs a request; a missed one costs an
   * operator scheduling against a stale board.
   *
   * Cost is a scan plus a hash, never a materialisation: the rows are read but
   * only two short hex digests cross the wire, instead of megabytes of JSON the
   * client then parses and holds twice over (placeholderData keeps the previous
   * result alive for the duration of a refetch).
   */
  async queueFingerprint(companyId: string): Promise<{
    pieces: { n: number; sig: string };
    beds: { n: number; sig: string };
  }> {
    // bed_id ships in the print_beds migration; gate it the same way listJobs
    // does rather than assume the column is there.
    const bedIdPart = (await this.hasBedColumn())
      ? "COALESCE(op.bed_id::text, ''),"
      : "";

    // CONCAT_WS with a separator, and COALESCE on every nullable member:
    // string_agg drops NULL inputs outright, so one un-coalesced NULL would
    // erase a whole piece from the digest and hide it changing. The separator
    // stops 'a'||'bc' colliding with 'ab'||'c'.
    const pieceSql = `
      SELECT COUNT(*)::int AS n,
             COALESCE(md5(string_agg(sig, ',' ORDER BY sig)), '-') AS sig
        FROM (
          SELECT CONCAT_WS('|',
                   op.piece_id::text,
                   op.status,
                   COALESCE(op.fulfilment_status, ''),
                   COALESCE(op.post_process_state, ''),
                   ${bedIdPart}
                   COALESCE(op.assigned_printer_id::text, ''),
                   COALESCE(op.assigned_nozzle_asset_id::text, ''),
                   COALESCE(op.resin_tank_id::text, ''),
                   COALESCE(op.scheduled_start_at::text, ''),
                   COALESCE(op.scheduled_end_at::text, ''),
                   COALESCE(op.print_started_at::text, ''),
                   COALESCE(op.print_completed_at::text, ''),
                   COALESCE(op.slicer_print_time_minutes::text, ''),
                   COALESCE(op.piece_name, '')
                 ) AS sig
            FROM order_pieces op
           WHERE op.company_id = $1
        ) s
    `;

    // Beds are hashed on their OWN columns only. fulfilment_status and
    // post_process_state are join-computed in bedSelectSql, not stored on
    // print_beds — naming them here would be a 500. Their underlying truth is
    // the child pieces, which the piece digest above already covers.
    const hasBeds = await this.hasBedsTable();
    const bedSql = `
      SELECT COUNT(*)::int AS n,
             COALESCE(md5(string_agg(sig, ',' ORDER BY sig)), '-') AS sig
        FROM (
          SELECT CONCAT_WS('|',
                   pb.bed_id::text,
                   pb.status,
                   COALESCE(pb.assigned_printer_id::text, ''),
                   COALESCE(pb.assigned_nozzle_asset_id::text, ''),
                   COALESCE(pb.resin_tank_id::text, ''),
                   COALESCE(pb.scheduled_start_at::text, ''),
                   COALESCE(pb.scheduled_end_at::text, ''),
                   COALESCE(pb.print_started_at::text, ''),
                   COALESCE(pb.print_completed_at::text, ''),
                   COALESCE(pb.bed_name, '')
                 ) AS sig
            FROM print_beds pb
           WHERE pb.company_id = $1 AND pb.status != 'disassembled'
        ) s
    `;

    const pieces = await this.databaseService.query<{ n: number; sig: string }>(
      pieceSql,
      [companyId]
    );
    const beds = hasBeds
      ? await this.databaseService.query<{ n: number; sig: string }>(bedSql, [companyId])
      : null;

    return {
      pieces: { n: pieces.rows[0]?.n ?? 0, sig: pieces.rows[0]?.sig ?? "-" },
      beds: { n: beds?.rows[0]?.n ?? 0, sig: beds?.rows[0]?.sig ?? "-" },
    };
  }

  // ──────────────────────────────────────────────────────────
  // GET /api/jobs/queue/summary
  // ──────────────────────────────────────────────────────────
  /**
   * The filter dropdowns and the stage tab counts, computed in SQL.
   *
   * Both were derived on the client by walking the entire row array — which is
   * a large part of why the client had to hold every row in the first place.
   * `Array.from(new Set(rows.map(...)))` for three facets plus a per-stage
   * `rows.filter(...).length` is cheap at a hundred pieces and is a reason to
   * ship 16.5 MB at ten thousand.
   *
   * The stage counts mirror the client's `effectiveStage`: a done piece is
   * reported under its post-process stage if it has one and isn't cured, else
   * its shipping stage if that isn't 'none', else plain 'done'. Anything not
   * done reports its own status. Keep the two in step — this decides the numbers
   * on the tabs the operator navigates by.
   */
  async queueSummary(
    companyId: string,
    query: ListJobsQuery
  ): Promise<{
    orders: string[];
    customers: string[];
    technologies: string[];
    stageCounts: Record<string, number>;
    total: number;
  }> {
    const { wheres, values } = await this.buildQueueFilter(companyId, query);
    const where = `WHERE ${wheres.join(" AND ")} AND o.status IN ${JobsService.QUEUE_ORDER_STATUSES}`;

    const sql = `
      WITH scoped AS (
        SELECT op.status,
               op.fulfilment_status,
               op.post_process_state,
               op.required_print_technology,
               o.order_number,
               COALESCE(
                 NULLIF(cu.business_name, ''),
                 NULLIF(TRIM(CONCAT_WS(' ', cu.first_name, cu.last_name)), '')
               ) AS customer_name
          FROM order_pieces op
          JOIN orders o          ON o.order_id = op.order_id AND o.company_id = op.company_id
          LEFT JOIN customers cu ON cu.customer_id = o.customer_id
        ${where}
      ),
      staged AS (
        SELECT CASE
                 WHEN status <> 'done' THEN status
                 -- SHIPPING OUTRANKS POST-PROCESSING, and the order of these two
                 -- branches is the whole meaning of the rule: once a part is
                 -- moving it has necessarily cured. This mirrors the client's
                 -- effectiveStage() exactly. Written the other way round, a resin
                 -- piece that is both post-processed AND shipping reports its
                 -- wash/cure stage instead of its shipping stage — which lands it
                 -- under the wrong tab and, far worse, makes mark-mode's stage
                 -- lock select the wrong pieces for a bulk shipping advance.
                 WHEN fulfilment_status IS NOT NULL AND fulfilment_status <> 'none'
                   THEN fulfilment_status
                 WHEN post_process_state IS NOT NULL AND post_process_state <> 'cured'
                   THEN post_process_state
                 ELSE 'done'
               END AS stage
          FROM scoped
      )
      SELECT
        (SELECT COALESCE(json_agg(DISTINCT order_number ORDER BY order_number), '[]'::json)
           FROM scoped WHERE order_number IS NOT NULL)          AS orders,
        (SELECT COALESCE(json_agg(DISTINCT customer_name ORDER BY customer_name), '[]'::json)
           FROM scoped WHERE customer_name IS NOT NULL AND customer_name <> '') AS customers,
        (SELECT COALESCE(json_agg(DISTINCT required_print_technology ORDER BY required_print_technology), '[]'::json)
           FROM scoped WHERE required_print_technology IS NOT NULL)             AS technologies,
        (SELECT COALESCE(json_object_agg(stage, n), '{}'::json)
           FROM (SELECT stage, COUNT(*)::int AS n FROM staged GROUP BY stage) g) AS stage_counts,
        (SELECT COUNT(*)::int FROM scoped)                       AS total
    `;

    const res = await this.databaseService.query<{
      orders: string[];
      customers: string[];
      technologies: string[];
      stage_counts: Record<string, number>;
      total: number;
    }>(sql, values);
    const row = res.rows[0];
    return {
      orders: row?.orders ?? [],
      customers: row?.customers ?? [],
      technologies: row?.technologies ?? [],
      stageCounts: row?.stage_counts ?? {},
      total: row?.total ?? 0,
    };
  }

  // ──────────────────────────────────────────────────────────
  // GET /api/jobs/queue/ids
  // ──────────────────────────────────────────────────────────
  /**
   * Every piece id the current filter matches — what Ctrl+A selects.
   *
   * Ids only, so selecting ten thousand pieces costs ~380 KB instead of the
   * 16.5 MB the client previously had to be holding for the same answer.
   *
   * `stage` narrows further to one effective stage, because the client's own
   * select-all is stage-aware: mark-mode locks the selection to a single
   * shipping/post-process stage so a bulk advance can never span two.
   *
   * SAFETY: this feeds bulk DELETE. It is scoped by exactly the same filter
   * builder the list uses, so it can never return something the operator cannot
   * see on screen.
   */
  async queueIds(
    companyId: string,
    query: ListJobsQuery & { stage?: string | undefined }
  ): Promise<{ piece_ids: string[]; total: number }> {
    const { wheres, values } = await this.buildQueueFilter(companyId, query);
    let where = `WHERE ${wheres.join(" AND ")} AND o.status IN ${JobsService.QUEUE_ORDER_STATUSES}`;

    if (query.stage) {
      values.push(query.stage);
      // Same branch order as queueSummary and the client's effectiveStage:
      // shipping outranks post-processing. See the note there.
      where += ` AND CASE
          WHEN op.status <> 'done' THEN op.status
          WHEN op.fulfilment_status IS NOT NULL AND op.fulfilment_status <> 'none'
            THEN op.fulfilment_status
          WHEN op.post_process_state IS NOT NULL AND op.post_process_state <> 'cured'
            THEN op.post_process_state
          ELSE 'done'
        END = $${values.length}`;
    }

    // The customers LEFT JOIN is required, not decorative: buildQueueFilter's
    // customer_name predicate resolves the same COALESCE(business_name, first +
    // last) expression the row projection does, and that needs `cu` in scope.
    const res = await this.databaseService.query<{ piece_id: string }>(
      `SELECT op.piece_id
         FROM order_pieces op
         JOIN orders o          ON o.order_id = op.order_id AND o.company_id = op.company_id
         LEFT JOIN customers cu ON cu.customer_id = o.customer_id
       ${where}
        ORDER BY op.created_at DESC`,
      values
    );
    const ids = res.rows.map((r) => r.piece_id);
    return { piece_ids: ids, total: ids.length };
  }

  // ──────────────────────────────────────────────────────────
  // GET /api/jobs/queue/assignable
  // ──────────────────────────────────────────────────────────
  /**
   * The pending, printer-less pieces the Bulk Assign flow starts from.
   *
   * Previously read off the full row array on the client
   * (`rows.filter(r => r.status === 'pending' && !r.assigned_printer_id)`),
   * which is one of the last things forcing that array to exist. Scoped through
   * the SAME buildQueueFilter as the list, so it keeps the existing behaviour
   * exactly — including that it inherits the active status/search scope, so
   * viewing "Printing" yields no candidates. That is what the client did, quirk
   * and all, and this is not the change in which to alter it.
   *
   * RETURNS `cost_inputs` RAW, AND DELIBERATELY DOES NOT DERIVE THE ASSUMED
   * FIGURES. Those numbers (`quoteAssumed` on the client) prefill the print-data
   * step and end up as the piece's slicer time and quantity, which is what the
   * job is costed and priced from. Re-implementing that arithmetic here — a
   * positives-only sum and a `Math.round(x * 100) / 100` — would mean two
   * expressions of one money rule that could drift apart, in different languages
   * with different rounding. The client keeps computing them with the function it
   * already uses, so the figures are identical by construction rather than by
   * inspection.
   */
  async queueAssignable(
    companyId: string,
    query: ListJobsQuery
  ): Promise<Array<Record<string, unknown>>> {
    const { wheres, values } = await this.buildQueueFilter(companyId, query);
    const where = [
      ...wheres,
      "op.status = 'pending'",
      "op.assigned_printer_id IS NULL",
    ].join(" AND ");

    const res = await this.databaseService.query(
      `SELECT
         op.piece_id,
         op.piece_name,
         o.order_number AS order_reference,
         o.deadline::text AS order_deadline,
         op.required_print_technology,
         op.resin_tank_id,
         op.cost_inputs,
         -- Byte-identical to jobSelectSql's expression, so a piece reads the
         -- same here as it does in the row the operator clicked from.
         CASE
           WHEN fr.filament_ref_id IS NOT NULL
             THEN fr.brand || ' ' || fr.material_type || ' (' || fr.color || ')'
           ELSE NULL
         END AS required_filament_label,
         COALESCE(
           NULLIF(cu.business_name, ''),
           NULLIF(TRIM(CONCAT_WS(' ', cu.first_name, cu.last_name)), '')
         ) AS customer_name
       FROM order_pieces op
       JOIN orders o                   ON o.order_id = op.order_id AND o.company_id = op.company_id
       LEFT JOIN customers cu          ON cu.customer_id = o.customer_id
       LEFT JOIN filament_reference fr ON fr.filament_ref_id = op.required_filament_ref_id
      WHERE ${where}
        AND o.status IN ${JobsService.QUEUE_ORDER_STATUSES}
      ORDER BY op.created_at DESC, op.piece_id ASC`,
      values
    );
    // Only PLATES carry `is_bed`; an absent flag reads as false at the one
    // place that tests it. Stamping `is_bed: false` onto every piece meant
    // copying the whole backlog — ten thousand row objects — to add a field
    // whose absence already says the same thing.
    const rows = res.rows as Array<Record<string, unknown>>;

    // ── Packed plates awaiting a printer ────────────────────────────────────
    //
    // A bed belongs in this list for the same reason it belongs on the queue:
    // it is a unit of work waiting for a machine. Leaving it out meant beds
    // could only ever be assigned one modal at a time, so they never
    // accumulated at 'ready' — and the fleet packer, which has handled beds all
    // along, looked like it ignored them.
    //
    // Its own query rather than a UNION with the above: the piece filter is
    // built from `op.`/`o.` predicates by buildQueueFilter and none of them
    // have a bed counterpart (a plate has no single order, customer or filament
    // reference). Forcing one shape over both would mean inventing bed columns
    // that do not exist. The search term is honoured because that is the filter
    // the picker actually exposes.
    //
    // Wrapped because a database still missing print_beds must degrade to the
    // pieces alone — which are correct on their own — rather than emptying a
    // list the operator is about to assign from.
    try {
      const q = (query.search ?? "").trim();
      const bedValues: unknown[] = [companyId];
      if (q) bedValues.push(`%${q.toLowerCase()}%`);
      const beds = await this.databaseService.query(
        `SELECT
           b.bed_id            AS piece_id,
           b.bed_name          AS piece_name,
           b.effective_deadline::text AS order_deadline,
           b.required_print_technology,
           b.resin_tank_id,
           -- Byte-identical to BedsService.bedSelectSql's expression (note the
           -- ' · ' separator, which differs from the piece one above), so a
           -- plate reads the same here as in the row the operator clicked from.
           CASE WHEN fr.filament_ref_id IS NOT NULL
                THEN fr.brand || ' ' || fr.material_type || ' · ' || fr.color
                ELSE NULL END AS required_filament_label,
           -- A plate can hold pieces from several orders, so there is no single
           -- order number to show. Name the one when there IS one, and say how
           -- many otherwise — a count is honest where a first-row guess is not.
           CASE WHEN COUNT(DISTINCT o.order_id) = 1
                THEN MIN(o.order_number)
                ELSE COUNT(DISTINCT o.order_id)::text || ' orders'
           END AS order_reference,
           CASE WHEN COUNT(DISTINCT o.customer_id) = 1
                THEN MIN(COALESCE(
                       NULLIF(cu.business_name, ''),
                       NULLIF(TRIM(CONCAT_WS(' ', cu.first_name, cu.last_name)), '')
                     ))
                ELSE NULL
           END AS customer_name
           -- Deliberately NOT shipping the constituent quotes.
           --
           -- A plate's assumed time and quantity are seeded SERVER-side at
           -- assign time, from these same rows; the list only has to let the
           -- operator choose. Sending them so the client could re-sum them was
           -- a body computed and then discarded — nothing rendered it, and
           -- piece rows show no assumed figures either — at roughly a dozen
           -- quote objects per plate. Showing them would also have been a
           -- half-truth, because the seed only applies when the plate has no
           -- figures of its own.
         FROM print_beds b
         LEFT JOIN order_pieces op ON op.bed_id = b.bed_id AND op.company_id = b.company_id
         LEFT JOIN orders o        ON o.order_id = op.order_id AND o.company_id = op.company_id
         LEFT JOIN customers cu    ON cu.customer_id = o.customer_id
         LEFT JOIN filament_reference fr ON fr.filament_ref_id = b.required_filament_ref_id
        WHERE b.company_id = $1
          AND b.status = 'pending'
          AND b.assigned_printer_id IS NULL
          -- Search matches the plate's own name OR anything identifying the work
          -- packed on it. Name-only looked sufficient and was a trap: searching a
          -- customer returned their loose pieces but hid the plate holding their
          -- parts, so the operator would assign the pieces and leave the plate
          -- behind — the exact omission this whole change exists to stop.
          ${q ? `AND (
            LOWER(b.bed_name) LIKE $2
            OR EXISTS (
              SELECT 1
                FROM order_pieces sp
                JOIN orders so      ON so.order_id = sp.order_id AND so.company_id = sp.company_id
                LEFT JOIN customers scu ON scu.customer_id = so.customer_id
               WHERE sp.company_id = b.company_id
                 AND sp.bed_id = b.bed_id
                 AND (
                   LOWER(sp.piece_name) LIKE $2
                   OR LOWER(so.order_number) LIKE $2
                   OR LOWER(COALESCE(
                        NULLIF(scu.business_name, ''),
                        NULLIF(TRIM(CONCAT_WS(' ', scu.first_name, scu.last_name)), '')
                      )) LIKE $2
                 )
            )
          )` : ""}
          -- Order scoping, matching the piece arm above.
          --
          -- Without this a plate whose work was cancelled or is still a draft
          -- would sit in the same list as live pieces and could be given a
          -- printer — and because assigning also SEEDS its print data, it would
          -- reach 'ready' and go on to occupy a real slot in the fleet pack.
          -- Machine time booked for work nobody ordered.
          --
          -- Spelled as EXISTS over the constituent pieces rather than a join
          -- predicate because a plate can hold pieces from several orders:
          -- the plate is live if ANY part of it is, which is the same rule
          -- jobSelectSql's bed arm applies. The status list is the PIECE arm's,
          -- deliberately — a plate and a loose piece from one order must appear
          -- or vanish together, and they sit side by side in this one modal.
          AND EXISTS (
            SELECT 1
              FROM order_pieces cp
              JOIN orders co ON co.order_id = cp.order_id AND co.company_id = cp.company_id
             WHERE cp.company_id = b.company_id
               AND cp.bed_id = b.bed_id
               AND co.status IN ${JobsService.QUEUE_ORDER_STATUSES}
          )
        GROUP BY b.bed_id, b.bed_name, b.effective_deadline,
                 b.required_print_technology, b.resin_tank_id,
                 fr.filament_ref_id, fr.brand, fr.material_type, fr.color,
                 b.created_at
        ORDER BY b.created_at DESC, b.bed_id ASC`,
        bedValues
      );
      for (const b of beds.rows) rows.push({ ...b, is_bed: true });
    } catch {
      /* print_beds not migrated yet — the pieces alone are correct */
    }
    return rows;
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
    const isResin = isResinTech(piece.required_print_technology);
    // A filament MATERIAL is required BEFORE assignment — the printer/material
    // compatibility check depends on it. A resin job has no filament material at
    // all; its material identity lives on the tank it's linked to.
    if (!isResin && !piece.required_filament_material) {
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
    // Skipped for resin, which has no nozzle to verify.
    if (isResin) {
      if (input.nozzle_asset_id) {
        throw new BadRequestException("A resin printer has no nozzle — omit nozzle_asset_id.");
      }
    } else {
      if (!input.nozzle_asset_id) {
        throw new BadRequestException("Pick a nozzle for this piece before assigning a printer.");
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

    // A linked tank must be a real resin tank in this company, and it must suit
    // the piece's light source — checked here rather than at schedule time so the
    // operator learns at the moment of choosing.
    if (input.resin_tank_id) {
      if (!isResin) {
        throw new BadRequestException("Resin tanks only apply to MSLA/SLA pieces.");
      }
      const tankRes = await this.databaseService.query<{ tech_compat: string | null }>(
        `SELECT COALESCE(resin_tech_compat, 'both') AS tech_compat
           FROM asset_instances
          WHERE company_id = $1 AND asset_id = $2 AND asset_type = 'resin_tank'
            AND split_at IS NULL`,
        [companyId, input.resin_tank_id]
      );
      const compat = tankRes.rows[0]?.tech_compat;
      if (!compat) {
        throw new BadRequestException("Selected resin tank does not exist, or has been split into child tanks.");
      }
      const tech = (piece.required_print_technology ?? "").trim().toUpperCase();
      if (compat !== "both" && compat !== tech) {
        throw new BadRequestException(
          `That resin is formulated for ${compat} printers, but this piece is ${tech}.`
        );
      }
    }

    // A resin piece cannot be 'ready' without a tank (chk_ready_requires_core_data),
    // and this wizard never asks for one — it collects the print data and nothing
    // else. Without resolving one here the piece lands 'assigned' and stops: the
    // operator has filled in everything the screen asked for and the job still
    // will not schedule, with nothing saying why.
    //
    // So resolve it the same way the one-click assign does, through the SAME
    // shared rule (pickTank): emptiest colour-matching tank that still covers the
    // draw. Only when the piece has none already and the caller named none.
    let resolvedTankId = input.resin_tank_id ?? null;
    if (isResin && !resolvedTankId && !piece.resin_tank_id) {
      const printerTech = (piece.required_print_technology ?? "").trim().toUpperCase();
      const tanks = await this.databaseService.query<TankChoice>(
        // resin_color is read through to_jsonb rather than named directly: its
        // migration (2026-08-13_resin_color.sql) may not be applied yet, and
        // naming a missing column makes the whole statement fail — which would
        // turn "colour is not recorded" into "no resin piece can be assigned at
        // all". Missing column reads as NULL, which colorCompatible treats as a
        // wildcard, so an un-migrated database simply skips colour matching.
        // Same idiom as the automated-messages column in order-notifications.
        `SELECT ai.asset_id,
                (COALESCE(ast.remaining_volume_ml, 0) - COALESCE(ast.reserved_volume_ml, 0))::double precision AS free_ml,
                NULLIF(TRIM(to_jsonb(ai) ->> 'resin_color'), '') AS resin_color
           FROM asset_instances ai
           JOIN asset_stock ast ON ast.asset_id = ai.asset_id
          WHERE ai.company_id = $1
            AND ai.asset_type = 'resin_tank'
            AND ai.split_at IS NULL
            AND COALESCE(ast.status, 'available') NOT IN ('damaged', 'empty')
            AND (ai.resin_expiry_date IS NULL OR ai.resin_expiry_date >= CURRENT_DATE)
            AND (COALESCE(ai.resin_tech_compat, 'both') = 'both'
                 OR COALESCE(ai.resin_tech_compat, 'both') = $2)
          ORDER BY (COALESCE(ast.remaining_volume_ml, 0) - COALESCE(ast.reserved_volume_ml, 0)) ASC`,
        [companyId, printerTech]
      );
      resolvedTankId = pickTank(tanks.rows, {
        needMl: input.slicer_resin_used_ml ?? null,
        wantColor: piece.required_color,
      });
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
      input.nozzle_asset_id ?? null,
      input.slicer_print_time_minutes,
      input.slicer_file_url ?? null,
      input.slicer_filament_used_grams ?? null,
    ];
    if (hasStl) values.push(input.stl_file_url ?? null);
    // Resin's quantity + tank ride at the end so the FDM placeholders above keep
    // their numbers (and the optional STL slot stays where it is).
    const resinBase = values.length;
    values.push(input.slicer_resin_used_ml ?? null, resolvedTankId);
    const mlParam = `$${resinBase + 1}`;
    const tankParam = `$${resinBase + 2}`;

    // Status decision is a function of the slicer METADATA, not the file. The
    // DB's chk_ready_requires_core_data constraint enforces that status='ready'
    // requires (printer, nozzle, slicer print time, filament grams) — so we set
    // 'ready' when both the print time ($5) and the COALESCE(new, existing)
    // filament grams are present, and 'assigned' otherwise. The slicer file and
    // STL have no bearing on status.
    const updated = await this.databaseService.query<JobRow>(
      `
        UPDATE order_pieces
           SET assigned_printer_id        = $3,
               assigned_nozzle_asset_id   = $4,
               slicer_print_time_minutes  = $5,
               slicer_file_url            = COALESCE($6, slicer_file_url),
               slicer_file_uploaded_at    = CASE WHEN $6 IS NOT NULL THEN now() ELSE slicer_file_uploaded_at END,
               slicer_filament_used_grams = COALESCE($7, slicer_filament_used_grams),
               slicer_resin_used_ml       = COALESCE(${mlParam}, slicer_resin_used_ml),
               resin_tank_id              = COALESCE(${tankParam}, resin_tank_id)
               ${stlSet}
         WHERE company_id = $1 AND piece_id = $2
         RETURNING piece_id
      `,
      values
    );
    if (updated.rowCount === 0) {
      throw new NotFoundException("Piece not found.");
    }

    // ── Status is set SEPARATELY, and deliberately so. ──────────────────────
    //
    // This used to ride along in the UPDATE above as a CASE. That coupled the
    // operator's DATA to a derived flag: if our CASE and the database's
    // chk_ready_requires_core_data disagreed by even one term, Postgres rejected
    // the whole statement, the print data the operator had just typed was thrown
    // away, and the browser got a bare "Internal server error" naming nothing.
    //
    // The two rules are maintained in different places (TypeScript here, SQL in
    // migrations/) and applied to databases at different times, so they WILL
    // disagree eventually — most obviously when a migration has not been applied
    // yet and an older constraint is still live. Writing the data first makes
    // that disagreement cost a status promotion instead of the operator's work.
    const after = await this.loadJob(companyId, pieceId);
    const target = this.isPieceSchedulable(after) ? "ready" : "assigned";
    if (after.status !== target) {
      try {
        await this.databaseService.query(
          `UPDATE order_pieces SET status = $3 WHERE company_id = $1 AND piece_id = $2`,
          [companyId, pieceId, target]
        );
      } catch (err) {
        // 23514 = check_violation. The database's readiness rule is stricter than
        // ours, which in practice means a pending migration. The slicer data is
        // already saved, so report what is actually wrong and let the operator
        // carry on rather than failing the whole save.
        const code = (err as { code?: string })?.code;
        if (code !== "23514") throw err;
        const constraint = (err as { constraint?: string })?.constraint ?? "a check constraint";
        throw new ConflictException(
          `The print data was saved, but this piece could not be marked '${target}': the database's ` +
          `readiness rule (${constraint}) rejected it. This normally means a migration in ` +
          `printexec-server/migrations/ has not been applied to this database yet — check ` +
          `GET /api/health/schema.`
        );
      }
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

    // Literal duplicates of this piece (same order/name/spec, metadata still
    // missing) inherit the confirmed time/grams — enter it once, cover the run.
    await propagateSlicerMetaToDuplicatesTx(this.databaseService, companyId, pieceId);

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
    // The slicer file is an optional attachment that no longer gates the
    // lifecycle, so it can be attached or removed in any non-terminal status
    // — including 'scheduled'/'printing' (the schedule is driven by the slicer
    // metadata, not the file). 'done' / 'failed' are terminal: the files stay
    // viewable/downloadable, but we don't allow swapping them.
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

    if (input.slicer_file_url !== undefined) {
      values.push(input.slicer_file_url);
      const idx = values.length;
      sets.push(`slicer_file_url = $${idx}`);
      sets.push(`slicer_file_uploaded_at = CASE WHEN $${idx}::text IS NULL THEN NULL ELSE now() END`);
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

    // Slicer metadata (parsed client-side on an inline attach) can ride along.
    // Unlike the file, the metadata DOES gate readiness: once a piece has both a
    // print time and filament grams it can be scheduled, so we mirror the assign
    // endpoint and flip an assignable piece 'assigned' ⇄ 'ready' to match. Pieces
    // outside that band (pending — no printer; scheduled/terminal) are left as-is,
    // and the STL/slicer file fields on their own still never change status.
    let timeExpr = "slicer_print_time_minutes";
    let gramsExpr = "slicer_filament_used_grams";
    let mlExpr = "slicer_resin_used_ml";
    if (input.slicer_print_time_minutes !== undefined) {
      values.push(input.slicer_print_time_minutes);
      timeExpr = `$${values.length}`;
      sets.push(`slicer_print_time_minutes = ${timeExpr}`);
    }
    if (input.slicer_filament_used_grams !== undefined) {
      values.push(input.slicer_filament_used_grams);
      gramsExpr = `$${values.length}`;
      sets.push(`slicer_filament_used_grams = ${gramsExpr}`);
    }
    if (input.slicer_resin_used_ml !== undefined) {
      values.push(input.slicer_resin_used_ml);
      mlExpr = `$${values.length}`;
      sets.push(`slicer_resin_used_ml = ${mlExpr}`);
    }
    const touchedSlicerMeta =
      input.slicer_print_time_minutes !== undefined ||
      input.slicer_filament_used_grams !== undefined ||
      input.slicer_resin_used_ml !== undefined;
    // Whether to recompute readiness AFTER the data lands. Deliberately not part
    // of the same UPDATE — see the note in assign(): coupling the operator's data
    // to a derived flag means one disagreement with the database's own readiness
    // rule discards the data and returns a bare 500.
    const recomputeStatus =
      touchedSlicerMeta && (piece.status === "assigned" || piece.status === "ready");

    if (sets.length === 0) return this.loadJob(companyId, pieceId);

    await this.databaseService.query(
      `UPDATE order_pieces SET ${sets.join(", ")}
        WHERE company_id = $1 AND piece_id = $2`,
      values
    );
    if (recomputeStatus) {
      const after = await this.loadJob(companyId, pieceId);
      const target = this.isPieceSchedulable(after) ? "ready" : "assigned";
      if (after.status !== target) {
        try {
          await this.databaseService.query(
            `UPDATE order_pieces SET status = $3 WHERE company_id = $1 AND piece_id = $2`,
            [companyId, pieceId, target]
          );
        } catch (err) {
          // Same contract as assign(): the files and metadata are already saved,
          // so a stricter database rule costs the promotion, not the work.
          if ((err as { code?: string })?.code !== "23514") throw err;
          const constraint = (err as { constraint?: string })?.constraint ?? "a check constraint";
          throw new ConflictException(
            `The slicer details were saved, but this piece could not be marked '${target}': the ` +
            `database's readiness rule (${constraint}) rejected it. This normally means a migration ` +
            `in printexec-server/migrations/ has not been applied — check GET /api/health/schema.`
          );
        }
      }
    }
    // Fresh metadata flows to any still-empty duplicates of this piece.
    if (touchedSlicerMeta) {
      await propagateSlicerMetaToDuplicatesTx(this.databaseService, companyId, pieceId);
    }
    return this.loadJob(companyId, pieceId);
  }

  // ──────────────────────────────────────────────────────────
  // POST /api/jobs/:pieceId/nozzle
  // Swap the assigned nozzle in place — no wizard round-trip. Only nozzles
  // from the assigned printer's compatibility table are accepted, and only
  // while the piece hasn't been committed to the timeline yet.
  // ──────────────────────────────────────────────────────────
  async setNozzle(
    companyId: string,
    pieceId: string,
    nozzleAssetId: string
  ): Promise<JobRow> {
    const piece = await this.loadJob(companyId, pieceId);
    if (!piece.assigned_printer_id) {
      throw new ConflictException("Assign a printer before choosing a nozzle.");
    }
    // Assigned/ready swap freely. A SCHEDULED piece may also swap — that's the
    // quick fix when the chosen nozzle turns out to be busy — but only onto a
    // nozzle that's actually free during its committed window.
    if (piece.status !== "assigned" && piece.status !== "ready" && piece.status !== "scheduled") {
      throw new ConflictException(
        `The nozzle can only be changed on an 'assigned', 'ready' or 'scheduled' piece (current: '${piece.status}').`
      );
    }
    if (piece.status === "scheduled" && piece.scheduled_start_at && piece.scheduled_end_at) {
      const conflict = await this.findResourceConflict(companyId, pieceId, {
        nozzleAssetId,
        spoolIds: [],
        startIso: piece.scheduled_start_at,
        endIso: piece.scheduled_end_at,
      });
      if (conflict) {
        throw new ConflictException(`Can't switch — ${conflict}. Pick a nozzle that's free in this print's window.`);
      }
    }
    const compat = await this.databaseService.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM printer_nozzle_compatibility
          WHERE company_id = $1 AND printer_id = $2 AND nozzle_asset_id = $3
       ) AS exists`,
      [companyId, piece.assigned_printer_id, nozzleAssetId]
    );
    if (!compat.rows[0]?.exists) {
      throw new BadRequestException(
        "Selected nozzle is not compatible with this piece's assigned printer."
      );
    }
    await this.databaseService.query(
      `UPDATE order_pieces
          SET assigned_nozzle_asset_id = $3
        WHERE company_id = $1 AND piece_id = $2`,
      [companyId, pieceId, nozzleAssetId]
    );
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

  /**
   * Commit a print window for one piece. The single door onto the board.
   *
   * `scheduleCommit` below is the whole of it; this adds the two things a
   * ONE-PIECE caller needs and a batch caller must not pay for per piece:
   *   · re-deriving the parent order's status, which aggregates EVERY piece in
   *     that order — so doing it per piece makes scheduling N pieces of one
   *     order O(N²). A batch does it once per distinct order at the end.
   *   · re-reading the piece, which the packer discards.
   * The rules themselves live in one place; only the epilogue differs.
   */
  async schedule(
    companyId: string,
    pieceId: string,
    input: ScheduleJobInput
  ): Promise<JobRow & { nozzle_switch?: NozzleSwitch }> {
    const { order_id, nozzle_switch } = await this.scheduleCommit(companyId, pieceId, input);
    await this.syncOrderStatus(companyId, order_id);
    const row = await this.loadJob(companyId, pieceId);
    // Rides back on the row rather than in a separate call: the operator has to
    // learn about a hardware change at the moment it happens, and this is the
    // only response the drop produces.
    return nozzle_switch ? { ...row, nozzle_switch } : row;
  }

  /**
   * The guarded commit, without the per-piece epilogue. Returns the parent
   * order so a batch caller can roll every affected order up ONCE.
   *
   * Every precondition, every resource-conflict check and the write itself are
   * here — a batch path that skipped them would be scheduling around the guard,
   * which is the one thing this must never allow.
   */
  async scheduleCommit(
    companyId: string,
    pieceId: string,
    input: ScheduleJobInput
  ): Promise<{ order_id: string; nozzle_switch: NozzleSwitch | null }> {
    const piece = await this.loadJob(companyId, pieceId);
    // 'assigned' is intentionally NOT allowed here — by design that status
    // means the slicer metadata is missing. The DB's chk_scheduled_requires_core_data
    // would reject anyway; the explicit check gives a friendlier message.
    if (piece.status !== "ready" && piece.status !== "scheduled") {
      // Name the quantity in the piece's OWN unit. Telling a resin operator to
      // enter "filament grams" sends them looking for a figure their job does
      // not have — the checks below already branch correctly, only this message
      // was still written for filament.
      const quantity = isResinTech(piece.required_print_technology)
        ? "resin millilitres"
        : "filament grams";
      throw new ConflictException(
        `Cannot schedule a '${piece.status}' piece. Enter its print time + ${quantity} (typed, quote-assumed, or read from a G-code) so it reaches 'ready' first.`
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
    // A resin printer has no nozzle and no spool. The two technologies have the
    // SAME shape of prerequisite — a machine, a material source, and a quantity
    // — so the checks below branch on unit rather than duplicating the flow.
    const isResin = isResinTech(piece.required_print_technology);
    if (!isResin && !piece.assigned_nozzle_asset_id) {
      throw new BadRequestException(
        "Piece has no assigned nozzle — assign one before scheduling."
      );
    }
    if (piece.slicer_print_time_minutes == null) {
      throw new BadRequestException(
        "Piece has no slicer print time — re-run the assignment flow."
      );
    }
    if (isResin) {
      if (piece.slicer_resin_used_ml == null) {
        throw new BadRequestException(
          "Piece has no slicer resin volume — enter the millilitres this print consumes. (Scheduling is gated on the slicer metadata, not the file.)"
        );
      }
      // The tank is resin's third timeline, exactly as the spool is filament's:
      // committing a window reserves volume against a specific physical tank.
      if (!piece.resin_tank_id) {
        throw new BadRequestException(
          "Link a resin tank from inventory before scheduling (a resin print draws from one physical tank)."
        );
      }
    } else {
      if (piece.slicer_filament_used_grams == null) {
        throw new BadRequestException(
          "Piece has no slicer filament usage — re-run the assignment flow. (Scheduling is gated on the slicer metadata, not the file.)"
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
    }
    // A physical spool instance must be reserved (assigned from stock) before
    // scheduling — that's the third timeline (printer + nozzle + spool).
    const reservedSpools = await this.databaseService.query<{ spool_asset_id: string }>(
      `SELECT spool_asset_id FROM order_piece_spools WHERE company_id = $1 AND piece_id = $2`,
      [companyId, pieceId]
    );
    if (!isResin && reservedSpools.rowCount === 0) {
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
    // Bed reservations anchor on a CHILD piece that carries no window of its
    // own (the window lives on print_beds), so the piece-level query above
    // can't see them — check the bed timeline for those spools explicitly.
    if (await this.hasBedsTable()) {
      const bedSpoolOverlap = await this.databaseService.query<{ bed_id: string }>(
        `SELECT pb.bed_id
           FROM print_beds pb
           JOIN order_pieces op ON op.bed_id = pb.bed_id AND op.company_id = pb.company_id
           JOIN order_piece_spools ops ON ops.piece_id = op.piece_id
          WHERE pb.company_id = $1
            AND ops.spool_asset_id = ANY($2::uuid[])
            AND pb.status IN ('scheduled','printing')
            AND pb.scheduled_start_at < $4
            AND pb.scheduled_end_at   > $3
          LIMIT 1`,
        [companyId, spoolIds, start.toISOString(), end.toISOString()]
      );
      if (bedSpoolOverlap.rowCount && bedSpoolOverlap.rowCount > 0) {
        throw new ConflictException(
          "A reserved spool is already feeding a scheduled print bed in this time slot — a spool can't be on two printers at once."
        );
      }
    }

    // Same rule for resin: a tank is poured into ONE vat, so it can't feed two
    // overlapping prints. No bed variant — a bed carries no tank of its own.
    if (piece.resin_tank_id) {
      const tankOverlap = await this.databaseService.query<{ piece_id: string }>(
        `SELECT op.piece_id
           FROM order_pieces op
          WHERE op.company_id = $1
            AND op.piece_id <> $2
            AND op.resin_tank_id = $3
            AND op.status IN ('scheduled','printing')
            AND op.scheduled_start_at < $5
            AND op.scheduled_end_at   > $4
          LIMIT 1`,
        [companyId, pieceId, piece.resin_tank_id, start.toISOString(), end.toISOString()]
      );
      if (tankOverlap.rowCount && tankOverlap.rowCount > 0) {
        throw new ConflictException(
          "That resin tank is already feeding another print in this time slot — a tank can't be in two vats at once."
        );
      }

      // Volume check: the tank must physically hold what this print will draw,
      // over and above what its other committed jobs have already reserved.
      const tankStock = await this.databaseService.query<{
        free_ml: string | null;
        label: string | null;
      }>(
        `SELECT COALESCE(ast.remaining_volume_ml, 0) - COALESCE(ast.reserved_volume_ml, 0) AS free_ml,
                NULLIF(TRIM(CONCAT_WS(' ', ai.resin_brand, ai.resin_type, ai.resin_color)), '') AS label
           FROM asset_instances ai
           JOIN asset_stock ast ON ast.asset_id = ai.asset_id
          WHERE ai.company_id = $1 AND ai.asset_id = $2`,
        [companyId, piece.resin_tank_id]
      );
      const free = Number(tankStock.rows[0]?.free_ml ?? 0);
      const needed = Number(piece.slicer_resin_used_ml ?? 0);
      if (needed > free) {
        throw new ConflictException(
          `${tankStock.rows[0]?.label ?? "That resin tank"} has ${Math.round(free)} ml free but this print needs ${Math.round(
            needed
          )} ml — top it up or pick another tank.`
        );
      }
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
    // printers at once. But WHICH 0.4mm brass nozzle runs the job is a
    // preference, not physics: when the chosen one is committed elsewhere in
    // this window, an identical free one takes over instead of the placement
    // being refused. Only when every twin is busy too is the slot genuinely
    // impossible. See resolveNozzleForWindow.
    let nozzleSwitch: NozzleSwitch | null = null;
    if (piece.assigned_nozzle_asset_id && piece.assigned_printer_id) {
      const verdict = await this.resolveNozzleForWindow(companyId, {
        printerId: piece.assigned_printer_id,
        nozzleAssetId: piece.assigned_nozzle_asset_id,
        startIso: start.toISOString(),
        endIso: end.toISOString(),
        excludePieceId: pieceId,
      });
      if (!verdict.ok) {
        throw new ConflictException(`The assigned nozzle ${verdict.blockedBy}.`);
      }
      nozzleSwitch = verdict.switchTo;
    }

    // The swap and the commitment land in ONE statement. Two would leave a
    // window where a piece wears a nozzle it was never scheduled onto if the
    // second failed — and this method has no transaction to roll that back.
    await this.databaseService.query(
      `
        UPDATE order_pieces
           SET scheduled_start_at = $3,
               scheduled_end_at   = $4,
               scheduled_at       = now(),
               status             = 'scheduled',
               assigned_nozzle_asset_id = COALESCE($5::uuid, assigned_nozzle_asset_id)
         WHERE company_id = $1 AND piece_id = $2
      `,
      [companyId, pieceId, start.toISOString(), end.toISOString(), nozzleSwitch?.to_nozzle_asset_id ?? null]
    );
    await this.recordPieceEvent(
      companyId, piece, "scheduled",
      `Piece "${piece.piece_name}" scheduled on ${piece.assigned_printer_label ?? "a printer"} for ${start.toISOString()}.`
    );
    if (nozzleSwitch) {
      // Its own history line: the schedule note above would otherwise be the
      // only record that a job changed hardware, and it doesn't say so.
      await this.recordPieceEvent(
        companyId, piece, "nozzle_switched",
        `Nozzle for "${piece.piece_name}" switched to ${nozzleSwitch.to_label}` +
        `${nozzleSwitch.displaced_by ? ` — ${nozzleSwitch.from_label ?? "the chosen nozzle"} is running "${nozzleSwitch.displaced_by}" in this slot` : ""}` +
        `${nozzleSwitch.moved_from_printer_label ? ` (currently fitted to ${nozzleSwitch.moved_from_printer_label})` : ""}.`
      );
    }
    return { order_id: piece.order_id, nozzle_switch: nozzleSwitch };
  }

  /** Re-derive one order's status. Public only so a batch caller that used
   *  `scheduleCommit` can settle the orders it touched, once each. */
  async syncOrderStatusOnce(companyId: string, orderId: string): Promise<void> {
    await this.syncOrderStatus(companyId, orderId);
  }

  /** First physical-resource conflict for a window, or null when everything is
   *  free. Checks the printer, the nozzle, and every spool reserved by the
   *  piece — against BOTH standalone pieces and print beds (bed spool
   *  reservations anchor on windowless child pieces, so beds are matched via
   *  their own timeline). `excludePieceId` skips the piece's own block. */
  private async findResourceConflict(
    companyId: string,
    excludePieceId: string,
    opts: {
      printerId?: string | null;
      nozzleAssetId?: string | null;
      spoolIds?: string[];
      resinTankId?: string | null;
      startIso: string;
      endIso: string;
    }
  ): Promise<string | null> {
    const { startIso, endIso } = opts;
    const hasBeds = await this.hasBedsTable();
    const spoolIds =
      opts.spoolIds ??
      (
        await this.databaseService.query<{ spool_asset_id: string }>(
          `SELECT spool_asset_id FROM order_piece_spools WHERE company_id = $1 AND piece_id = $2`,
          [companyId, excludePieceId]
        )
      ).rows.map((r) => r.spool_asset_id);

    const pieceHit = async (
      col: "assigned_printer_id" | "assigned_nozzle_asset_id" | "resin_tank_id",
      id: string
    ) =>
      (
        await this.databaseService.query<{ piece_name: string }>(
          `SELECT piece_name FROM order_pieces
            WHERE company_id = $1 AND ${col} = $2 AND piece_id <> $3
              AND status IN ('scheduled','printing')
              AND scheduled_start_at < $5 AND scheduled_end_at > $4
            LIMIT 1`,
          [companyId, id, excludePieceId, startIso, endIso]
        )
      ).rows[0]?.piece_name ?? null;
    const bedHit = async (col: "assigned_printer_id" | "assigned_nozzle_asset_id", id: string) =>
      !hasBeds
        ? null
        : (
            await this.databaseService.query<{ bed_name: string }>(
              `SELECT bed_name FROM print_beds
                WHERE company_id = $1 AND ${col} = $2
                  AND status IN ('scheduled','printing')
                  AND scheduled_start_at < $4 AND scheduled_end_at > $3
                LIMIT 1`,
              [companyId, id, startIso, endIso]
            )
          ).rows[0]?.bed_name ?? null;

    if (opts.printerId) {
      const p = await pieceHit("assigned_printer_id", opts.printerId);
      if (p) return `the printer is committed to "${p}" in that window`;
      const b = await bedHit("assigned_printer_id", opts.printerId);
      if (b) return `the printer is committed to bed "${b}" in that window`;
    }
    if (opts.nozzleAssetId) {
      const p = await pieceHit("assigned_nozzle_asset_id", opts.nozzleAssetId);
      if (p) return `the nozzle is committed to "${p}" in that window`;
      const b = await bedHit("assigned_nozzle_asset_id", opts.nozzleAssetId);
      if (b) return `the nozzle is committed to bed "${b}" in that window`;
    }
    // A resin tank sits in ONE vat at a time, so two overlapping resin jobs
    // drawing from the same tank is as physically impossible as sharing a
    // nozzle. Beds are not checked: a bed carries no tank of its own — its
    // pieces do, and those pieces are already covered by the piece probe.
    if (opts.resinTankId) {
      const p = await pieceHit("resin_tank_id", opts.resinTankId);
      if (p) return `the resin tank is committed to "${p}" in that window`;
    }
    if (spoolIds.length > 0) {
      const p = await this.databaseService.query<{ piece_name: string }>(
        `SELECT op.piece_name
           FROM order_pieces op
           JOIN order_piece_spools ops ON ops.piece_id = op.piece_id
          WHERE op.company_id = $1 AND op.piece_id <> $2
            AND ops.spool_asset_id = ANY($3::uuid[])
            AND op.status IN ('scheduled','printing')
            AND op.scheduled_start_at < $5 AND op.scheduled_end_at > $4
          LIMIT 1`,
        [companyId, excludePieceId, spoolIds, startIso, endIso]
      );
      if (p.rows[0]) return `a reserved spool is feeding "${p.rows[0].piece_name}" in that window`;
      if (hasBeds) {
        const b = await this.databaseService.query<{ bed_name: string }>(
          `SELECT pb.bed_name
             FROM print_beds pb
             JOIN order_pieces op ON op.bed_id = pb.bed_id AND op.company_id = pb.company_id
             JOIN order_piece_spools ops ON ops.piece_id = op.piece_id
            WHERE pb.company_id = $1
              AND ops.spool_asset_id = ANY($2::uuid[])
              AND pb.status IN ('scheduled','printing')
              AND pb.scheduled_start_at < $4 AND pb.scheduled_end_at > $3
            LIMIT 1`,
          [companyId, spoolIds, startIso, endIso]
        );
        if (b.rows[0]) return `a reserved spool is feeding bed "${b.rows[0].bed_name}" in that window`;
      }
    }
    return null;
  }

  /**
   * Which nozzle should ACTUALLY serve a print committed to [start, end)?
   *
   * The nozzle a human picked is a preference, not a physical constraint. A
   * shop that owns ten 0.4mm brass nozzles has ten identical ways to run a
   * 0.4mm brass job; the operator does not know or care which one is fitted,
   * and every one of them prints the part the same. Refusing the placement
   * because one specific asset row is committed elsewhere is the board being
   * precise about a distinction the workshop does not make.
   *
   * So: if the chosen nozzle is free, nothing happens. If it is busy, an
   * IDENTICAL free one takes its place (same diameter + material — see
   * `chooseInterchangeableNozzle`, which is the same interchangeability rule
   * the auto-packer has always used, so a drop and the ⚡ packer now answer the
   * same question the same way). Only when every twin is busy too is the
   * placement genuinely impossible, and only then does this refuse.
   *
   * The substitute is REPORTED, never silent: on screen every 0.4mm brass reads
   * identically, so an operator who is not told which one to fit has been given
   * an instruction they cannot follow.
   *
   * Costs one indexed probe on the happy path (idx_order_pieces_nozzle_schedule_window),
   * and one bounded roster read — the nozzles compatible with this ONE printer —
   * only when there is a conflict to resolve.
   *
   * Read-then-write, like every other guard in scheduleCommit: two operators
   * committing overlapping windows onto the last free twin in the same instant
   * can both be told yes. That race is the one this method inherits rather than
   * introduces — it is the same shape as the printer and spool checks above it,
   * and the blast radius is the same too (a double-booked resource the board
   * shows, not lost or corrupted work). Closing it properly means an exclusion
   * constraint over (nozzle, window), which would close all three at once and
   * is a migration, not a code change.
   */
  async resolveNozzleForWindow(
    companyId: string,
    opts: {
      printerId: string;
      nozzleAssetId: string;
      startIso: string;
      endIso: string;
      /** The job's own committed block, which must not count against itself. */
      excludePieceId?: string | null | undefined;
      excludeBedId?: string | null | undefined;
    }
  ): Promise<
    | { ok: true; switchTo: NozzleSwitch | null }
    | { ok: false; blockedBy: string }
  > {
    const { printerId, nozzleAssetId, startIso, endIso } = opts;
    const hasBeds = await this.hasBedsTable();
    const excludePieceId = opts.excludePieceId ?? null;
    const excludeBedId = opts.excludeBedId ?? null;

    // ── Is the chosen nozzle double-booked at all? Named by the EARLIEST thing
    //    holding it, so the refusal below can say what it is rather than "busy".
    const busyParams: unknown[] = [companyId, nozzleAssetId, startIso, endIso, excludePieceId];
    if (hasBeds) busyParams.push(excludeBedId);
    const busyRes = await this.databaseService.query<{ label: string | null }>(
      nozzleBusyProbeSql(hasBeds),
      busyParams
    );
    const displacedBy = busyRes.rows[0]?.label ?? null;
    // The overwhelmingly common case: the chosen nozzle is free, nothing to
    // decide, and the roster below is never read.
    if (!busyRes.rowCount) return { ok: true, switchTo: null };

    // ── Busy. Look for an identical stand-in among the nozzles this printer can
    //    mount. `busy` is computed per candidate in the same statement so the
    //    roster arrives already answering the only question we have of it.
    const rosterParams: unknown[] = [companyId, printerId, startIso, endIso, excludePieceId];
    if (hasBeds) rosterParams.push(excludeBedId);
    const roster = await this.databaseService.query<{
      nozzle_asset_id: string;
      nozzle_diameter_mm: string | number | null;
      nozzle_material: string | null;
      nozzle_name: string | null;
      nozzle_brand: string | null;
      location: string | null;
      status: string;
      installed_on: string | null;
      installed_on_label: string | null;
      busy: boolean;
    }>(nozzleRosterSql(hasBeds), rosterParams);

    const options: NozzleOption[] = roster.rows.map((r) => ({
      nozzle_asset_id: r.nozzle_asset_id,
      nozzle_diameter_mm: r.nozzle_diameter_mm != null ? Number(r.nozzle_diameter_mm) : null,
      nozzle_material: r.nozzle_material,
      status: r.status,
      installed_on: r.installed_on,
      label: nozzleIdentityLabel(r),
    }));
    const assigned = roster.rows.find((r) => r.nozzle_asset_id === nozzleAssetId);
    const busyById = new Map(roster.rows.map((r) => [r.nozzle_asset_id, r.busy]));

    const pick = assigned
      ? chooseInterchangeableNozzle({
          assignedId: nozzleAssetId,
          assignedDiameterMm: assigned.nozzle_diameter_mm != null ? Number(assigned.nozzle_diameter_mm) : null,
          assignedMaterial: assigned.nozzle_material,
          printerId,
          options,
          isFree: (id) => busyById.get(id) === false,
        })
      : null;

    if (!pick) {
      // No identical nozzle is free either — the window really is impossible.
      return {
        ok: false,
        blockedBy: displacedBy
          ? `is already in use by "${displacedBy}" in this time slot, and every identical nozzle on this printer is busy too`
          : "is already in use in this time slot",
      };
    }
    const picked = roster.rows.find((r) => r.nozzle_asset_id === pick.nozzle_asset_id)!;
    return {
      ok: true,
      switchTo: {
        from_nozzle_asset_id: nozzleAssetId,
        from_label: assigned ? nozzleIdentityLabel(assigned) : null,
        to_nozzle_asset_id: pick.nozzle_asset_id,
        to_label: pick.label,
        to_location: picked.location,
        moved_from_printer_id: picked.installed_on && picked.installed_on !== printerId ? picked.installed_on : null,
        moved_from_printer_label: picked.installed_on && picked.installed_on !== printerId
          ? picked.installed_on_label
          : null,
        displaced_by: displacedBy,
      },
    };
  }

  /** Readiness/scheduling is gated on slicer METADATA (print time + how much
   *  material the job consumes) plus an assigned printer + nozzle — never on the
   *  slicer file, which is an optional attachment the system never feeds to a
   *  printer.
   *
   *  "How much material" is measured in the technology's own unit: grams of
   *  filament for FDM, millilitres of resin for MSLA/SLA. A resin job has no
   *  gram figure at all (resin is priced and stocked by volume), so gating it on
   *  slicer_filament_used_grams would make every resin piece permanently
   *  un-ready. */
  private hasSlicerCoreData(piece: {
    slicer_print_time_minutes: number | null;
    slicer_filament_used_grams: number | null;
    required_print_technology?: string | null;
    slicer_resin_used_ml?: number | string | null;
  }): boolean {
    if (piece.slicer_print_time_minutes == null) return false;
    return isResinTech(piece.required_print_technology)
      ? piece.slicer_resin_used_ml != null
      : piece.slicer_filament_used_grams != null;
  }

  /** Does this piece have everything its TECHNOLOGY needs to be schedulable?
   *  Filament: printer + nozzle + time + grams. Resin: printer + tank + time +
   *  millilitres. Mirrors BedsService.isBedSchedulable — the bed half of this
   *  pair already existed, the piece half did not, so reprint() and restore()
   *  each wrote the FILAMENT test by hand (`assigned_nozzle_asset_id && …`).
   *  A resin piece has no nozzle and never will, so both silently demoted every
   *  resin piece to 'assigned' and sent the operator back through a print-data
   *  step for a piece that already had its numbers. */
  private isPieceSchedulable(piece: {
    assigned_printer_id: string | null;
    assigned_nozzle_asset_id: string | null;
    resin_tank_id?: string | null;
    required_print_technology?: string | null;
    slicer_print_time_minutes: number | null;
    slicer_filament_used_grams: number | null;
    slicer_resin_used_ml?: number | string | null;
  }): boolean {
    if (!piece.assigned_printer_id || !this.hasSlicerCoreData(piece)) return false;
    return isResinTech(piece.required_print_technology)
      ? !!piece.resin_tank_id
      : !!piece.assigned_nozzle_asset_id;
  }

  async unschedule(companyId: string, pieceId: string): Promise<JobRow> {
    const piece = await this.loadJob(companyId, pieceId);
    if (piece.status !== "scheduled") {
      throw new ConflictException(
        `Only 'scheduled' pieces can be unscheduled (current: '${piece.status}').`
      );
    }
    // After unschedule the piece keeps printer+nozzle+slicer metadata (it was
    // 'scheduled', so all of those were present per
    // chk_scheduled_requires_core_data), so we drop back to 'ready'. If the
    // metadata is somehow missing, fall back to 'assigned'.
    const target = this.hasSlicerCoreData(piece) ? "ready" : "assigned";
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
    // Starting means the machine physically runs NOW. Verify the printer, the
    // nozzle, every reserved spool and the resin tank are free for the whole run
    // window — "start now" must respect ALL involved timelines, not just this
    // piece's. (The piece's own scheduled block is excluded; it's the run being
    // started.)
    {
      const durMin = piece.slicer_print_time_minutes != null ? Number(piece.slicer_print_time_minutes) : 1;
      const runStart = new Date();
      const runEnd = new Date(runStart.getTime() + Math.max(1, durMin) * 60_000);
      const conflict = await this.findResourceConflict(companyId, pieceId, {
        printerId: piece.assigned_printer_id,
        nozzleAssetId: piece.assigned_nozzle_asset_id,
        resinTankId: piece.resin_tank_id ?? null,
        startIso: runStart.toISOString(),
        endIso: runEnd.toISOString(),
      });
      if (conflict) {
        throw new ConflictException(
          `Can't start now — ${conflict}. Reschedule one of them or pick a free resource first.`
        );
      }
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
    // A finished resin print is not a finished PART — it comes off the plate
    // wet and enters the wash/cure queue. Stamping 'print_done' here (and only
    // here) is what puts it in front of an operator; a failed run never enters
    // the queue, because there is nothing worth washing.
    const entersPostProcess =
      input.outcome === "done" && isResinTech(piece.required_print_technology);

    await this.databaseService.query(
      `
        UPDATE order_pieces
           SET status                     = $3,
               print_started_at           = COALESCE(print_started_at, scheduled_start_at, now()),
               print_completed_at         = now(),
               actual_print_time_minutes  = COALESCE($4, actual_print_time_minutes),
               actual_filament_used_grams = COALESCE($5, actual_filament_used_grams),
               post_process_state            = CASE WHEN $6 THEN 'print_done' ELSE post_process_state END,
               post_process_state_entered_at = CASE WHEN $6 THEN now() ELSE post_process_state_entered_at END
         WHERE company_id = $1 AND piece_id = $2
      `,
      [
        companyId,
        pieceId,
        input.outcome,
        input.actual_print_time_minutes ?? null,
        input.actual_filament_used_grams ?? null,
        entersPostProcess,
      ]
    );
    // The print ran (done or failed) → the reserved material is consumed:
    // deduct it from the spool's remaining grams / the tank's remaining
    // millilitres and release the reservation, and free the assigned printer
    // (live counterpart of the old releaseExecutionResources). No-op for a
    // never-started 'scheduled' piece.
    const completePrinterId = piece.assigned_printer_id;
    await this.databaseService.transaction(async (c) => {
      await this.consumeSpoolsTx(c, companyId, pieceId);
      await this.consumeResinTx(c, companyId, pieceId);
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
    const target = this.isPieceSchedulable(piece)
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
              actual_filament_used_grams = NULL,
              -- A re-queued print has nothing to wash yet. Clearing this pulls
              -- the old run out of the post-processing queue; the reprint
              -- re-enters it when it completes.
              post_process_state            = NULL,
              post_process_state_entered_at = NULL
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
      // If the piece carries all `ready` prereqs for its technology (printer +
      // nozzle-or-tank + slicer metadata), promote it straight to 'ready' so the
      // operator can schedule immediately without re-confirming the slicer step.
      const targetStatus = this.isPieceSchedulable(piece) ? "ready" : "assigned";
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
             pi.print_technology AS assigned_printer_technology,
             pi.marker           AS assigned_printer_marker,
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
    const [printerRes, scheduledRes, floatingRes, poolRes] = await Promise.all([
      this.databaseService.query<{
        printer_id: string;
        brand: string;
        model: string;
        location: string | null;
        // The board needs this to know which RESOURCE LANES are even meaningful.
        // Without it the client could only infer the machine's technology from
        // the pieces on it, which is exactly backwards — a resin printer is a
        // resin printer with an empty board.
        print_technology: string | null;
        // The operator's physical tag for this machine. Travels with the board
        // so a lane can name the box in the room, not just its model.
        marker: string | null;
        is_under_maintenance: boolean;
        is_offline: boolean;
      }>(
        `SELECT pi.printer_id, pi.brand, pi.model, pi.location, pi.print_technology, pi.marker,
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
      // ── The printer's nozzles grouped by SPEC, each with what it is already
      //    committed to. The board needs this to place a chip honestly: a piece
      //    whose nozzle is busy is only actually blocked when every nozzle of
      //    that same spec is busy, because scheduleCommit will substitute a free
      //    twin (see resolveNozzleForWindow). Without it the board would keep
      //    shoving drops forward past a conflict the server no longer has.
      //
      //    Bounded by ONE printer's compatibility roster — a handful of rows —
      //    and the blocks are pre-filtered to those nozzles so the window scan
      //    rides idx_order_pieces_nozzle_schedule_window rather than walking the
      //    tenant's pieces.
      this.databaseService.query<NozzlePoolRow>(
        nozzlePoolSql(hasBeds),
        [companyId, printerId, query.from, query.to]
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

    // A resin machine has no nozzle at all, so it gets no pools even if a stale
    // compatibility row survives from before that was enforced — exactly the row
    // that once put a "0.40mm brass" lane on a Formlabs.
    const printer = printerRes.rows[0]!;
    return {
      printer,
      scheduled: [...withSpools(scheduledRes.rows), ...withSpools(bedScheduled)],
      floating: [...floatingRes.rows, ...bedFloating],
      nozzle_pools: isResinTech(printer.print_technology)
        ? []
        : foldNozzlePools(poolRes.rows, nozzleSpecOf),
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
                pi.print_technology AS assigned_printer_technology,
                pi.marker           AS assigned_printer_marker,
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
                -- A resin PLATE binds a tank exactly as a resin piece does; the
                -- timeline pivots by literal tank, so a bed block that omitted
                -- these would silently fall into the "no tank" lane.
                pb.resin_tank_id,
                pb.slicer_resin_used_ml,
                NULLIF(TRIM(CONCAT_WS(' ', rt.resin_brand, rt.resin_type, rt.resin_color)), '')
                  AS resin_tank_label,
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
           LEFT JOIN asset_instances rt ON rt.asset_id = pb.resin_tank_id
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

  // The resin counterpart of spoolTimeline: a job's tank is a column on the row
  // rather than a join-table reservation, so there is no per-slot sequence and
  // no anchoring indirection — a PLATE carries its own tank the same way a piece
  // does. Same response shape, so one client panel renders both.
  //
  // Bed-owned pieces are excluded from both halves on purpose: their scheduling
  // window and their volume live on the PLATE, and counting the parts as well as
  // the plate would draw the same resin down twice on the depletion curve.
  async tankTimeline(companyId: string, tankAssetId: string, query: TimelineQuery) {
    const hasStl = await this.hasStlColumn();
    const [tankRes, scheduledRes, ledgerRes] = await Promise.all([
      this.databaseService.query<{
        tank_asset_id: string;
        initial_volume_ml: number | null;
        remaining_volume_ml: number | null;
        reserved_volume_ml: number | null;
        status: string;
        resin_label: string | null;
        expiry_date: string | null;
      }>(
        `SELECT ai.asset_id AS tank_asset_id,
                ai.resin_initial_volume_ml AS initial_volume_ml,
                ast.remaining_volume_ml, ast.reserved_volume_ml,
                COALESCE(ast.status, 'available') AS status,
                NULLIF(TRIM(CONCAT_WS(' · ', NULLIF(TRIM(CONCAT_WS(' ', ai.resin_brand, ai.resin_type)), ''), ai.resin_color)), '') AS resin_label,
                ai.resin_expiry_date::text AS expiry_date
           FROM asset_instances ai
           LEFT JOIN asset_stock ast ON ast.asset_id = ai.asset_id
          WHERE ai.company_id = $1 AND ai.asset_id = $2 AND ai.asset_type = 'resin_tank'`,
        [companyId, tankAssetId]
      ),
      this.databaseService.query<JobRow>(
        this.jobSelectSql(
          hasStl,
          `WHERE op.company_id = $1
             AND op.resin_tank_id = $2
             AND op.bed_id IS NULL
             AND op.status IN ('scheduled','printing','done','failed')
             AND op.scheduled_start_at < $4
             AND op.scheduled_end_at   > $3`,
          "op.scheduled_start_at ASC",
          true
        ),
        [companyId, tankAssetId, query.from, query.to]
      ),
      // Full draw ledger (every job that ever pointed at this tank), ordered by
      // run time — the tank's depletion history. Plates and standalone pieces
      // are one list: both draw from the same bottle.
      this.databaseService.query<{
        piece_id: string;
        piece_name: string;
        planned_ml: string | null;
        status: JobStatus;
        scheduled_start_at: string | null;
      }>(
        `SELECT op.piece_id, op.piece_name,
                op.slicer_resin_used_ml AS planned_ml,
                op.status,
                COALESCE(op.scheduled_start_at, op.print_started_at) AS scheduled_start_at
           FROM order_pieces op
          WHERE op.company_id = $1 AND op.resin_tank_id = $2 AND op.bed_id IS NULL
         UNION ALL
         SELECT pb.bed_id AS piece_id, pb.bed_name AS piece_name,
                pb.slicer_resin_used_ml AS planned_ml,
                pb.status,
                COALESCE(pb.scheduled_start_at, pb.print_started_at) AS scheduled_start_at
           FROM print_beds pb
          WHERE pb.company_id = $1 AND pb.resin_tank_id = $2
          ORDER BY scheduled_start_at ASC NULLS LAST`,
        [companyId, tankAssetId]
      ),
    ]);
    if (tankRes.rowCount === 0) throw new NotFoundException("Resin tank not found.");

    // Scheduled resin PLATES occupy the tank exactly as pieces do. Shaped like a
    // JobRow with `is_bed`, matching what spoolTimeline already does for spools,
    // so the timeline panel routes a click to the bed detail.
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
                pi.print_technology AS assigned_printer_technology,
                pi.marker           AS assigned_printer_marker,
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
                pb.resin_tank_id,
                pb.slicer_resin_used_ml,
                NULLIF(TRIM(CONCAT_WS(' ', rt.resin_brand, rt.resin_type, rt.resin_color)), '')
                  AS resin_tank_label,
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
           LEFT JOIN asset_instances rt ON rt.asset_id = pb.resin_tank_id
          WHERE pb.company_id = $1
            AND pb.resin_tank_id = $2
            AND pb.status IN ('scheduled','printing','done','failed')
            AND pb.scheduled_start_at < $4
            AND pb.scheduled_end_at   > $3`,
        [companyId, tankAssetId, query.from, query.to]
      );
      bedBlocks = bedsRes.rows;
    }

    const mlById = new Map<string, number>();
    for (const r of ledgerRes.rows) {
      if (r.planned_ml != null) mlById.set(r.piece_id, Number(r.planned_ml));
    }

    return {
      tank: tankRes.rows[0]!,
      scheduled: [...scheduledRes.rows, ...bedBlocks].map((r) => ({
        ...r,
        planned_ml: mlById.get(r.piece_id) ?? null,
      })),
      ledger: ledgerRes.rows.map((r) => ({
        piece_id: r.piece_id,
        piece_name: r.piece_name,
        planned_ml: r.planned_ml != null ? Number(r.planned_ml) : null,
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
      asset_id: string; label: string | null; marker: string | null; material_type: string | null; color: string | null; remaining_grams: string | null; reserved_grams: string | null; status: string; initial_grams: string | null; parent_asset_id: string | null;
    }>(
      // initial_grams + parent_asset_id are selected for the Storage /
      // Operational Inventory classification, which is computed from grams and
      // lineage rather than status — see common/spool-choice.ts.
      `SELECT ai.asset_id,
              ai.marker,
              ai.initial_grams,
              ai.parent_asset_id,
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
          -- A distributed (split) parent is unusable; only its children are allocatable.
          AND ai.split_at IS NULL
          AND COALESCE(ast.status, 'available') IN ('available','in_use','installed')`,
      [companyId]
    );
    const spools = res.rows
      .filter((r) => r.material_type != null && materialFamily(r.material_type) === wantFamily)
      .filter((r) => color == null || sameColor(r.color, color))
      .map((r) => {
      const remaining = Number(r.remaining_grams ?? 0);
      const reserved = Number(r.reserved_grams ?? 0);
      return {
        spool_asset_id: r.asset_id, label: r.label, marker: r.marker, remaining, reserved,
        status: r.status, free: Math.max(0, remaining - reserved),
        initial_grams: r.initial_grams, parent_asset_id: r.parent_asset_id,
      };
    });
    // Preference order (see common/spool-choice.ts): Operational Inventory —
    // anything already opened, reserved against, or split off another spool —
    // beats untouched Storage, and within a tier the one with the most
    // unreserved grams wins. Same classification the Storage / Operational
    // Inventory badges use, so a plan agrees with the Assets screen.
    spools.sort(compareSpoolPreference);

    const best = bestSingleSpool(spools, needed);
    if (best) {
      return { ...base, spools, plan: "single" as const, allocation: [{ spool_asset_id: best.spool_asset_id, label: best.label, grams: needed, sequence: 1 }] };
    }
    const totalFree = spools.reduce((sum, s) => sum + s.free, 0);
    if (totalFree >= needed) {
      // Combine: draw in the same preference order — finish what's open before
      // opening something new.
      const allocation: typeof base.allocation = [];
      let remaining = needed;
      let seq = 1;
      for (const s of combineOrder(spools)) {
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

  /** Consume reserved resin on completion: the linked tank's remaining volume
   *  drops by the millilitres this print drew. The resin counterpart of
   *  consumeSpoolsTx, with the same division of labour — reserved_volume_ml is
   *  owned by fn_recalc_reserved_volume_for_tank (the piece's status flip to
   *  done/failed already fired it), so this only deducts what was physically
   *  used and flags a drained tank. */
  private async consumeResinTx(client: import("pg").PoolClient, companyId: string, pieceId: string): Promise<void> {
    await client.query(
      `UPDATE asset_stock ast
          SET remaining_volume_ml = GREATEST(0, COALESCE(ast.remaining_volume_ml, 0) - op.slicer_resin_used_ml),
              status = CASE
                         WHEN GREATEST(0, COALESCE(ast.remaining_volume_ml, 0) - op.slicer_resin_used_ml) <= 0
                           THEN 'empty'
                         ELSE ast.status
                       END
         FROM order_pieces op
        WHERE op.company_id = $1
          AND op.piece_id = $2
          AND op.resin_tank_id = ast.asset_id
          AND op.slicer_resin_used_ml IS NOT NULL`,
      [companyId, pieceId]
    );
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
        // Same two identity facts the single-printer board already carries, so
        // a lane on the multi-printer timeline can say what the machine is and
        // which physical box it is — a row of identical models is otherwise
        // indistinguishable here.
        print_technology: string | null;
        marker: string | null;
        is_under_maintenance: boolean;
        is_offline: boolean;
      }>(
        `SELECT pi.printer_id, pi.brand, pi.model, pi.serial_number, pi.location,
                pi.print_technology, pi.marker,
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
                pi.print_technology AS assigned_printer_technology,
                pi.marker           AS assigned_printer_marker,
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
                -- A resin PLATE binds a tank exactly as a resin piece does; the
                -- timeline pivots by literal tank, so a bed block that omitted
                -- these would silently fall into the "no tank" lane.
                pb.resin_tank_id,
                pb.slicer_resin_used_ml,
                NULLIF(TRIM(CONCAT_WS(' ', rt.resin_brand, rt.resin_type, rt.resin_color)), '')
                  AS resin_tank_label,
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
           LEFT JOIN asset_instances rt ON rt.asset_id = pb.resin_tank_id
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
