import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { DatabaseService, type SqlExecutor } from "../database/database.service";
import { FinanceService } from "../finance/finance.service";
import { buildUpdateClause } from "../common/sql";
import {
  createFilamentReferenceSchema,
  createNozzleSchema,
  createResinTankSchema,
  createSpoolSchema,
  listAssetsQuerySchema,
  listAssetHistoryQuerySchema,
  listFilamentReferencesQuerySchema,
  splitSpoolSchema,
  updateAssetSchema,
  updateAssetStockSchema
} from "./assets.schemas";
import type { z } from "zod";

type FilamentReferenceInput = z.infer<typeof createFilamentReferenceSchema>;
type CreateSpoolInput = z.infer<typeof createSpoolSchema>;
type CreateNozzleInput = z.infer<typeof createNozzleSchema>;
type CreateResinTankInput = z.infer<typeof createResinTankSchema>;
type ListAssetsQuery = z.infer<typeof listAssetsQuerySchema>;
type UpdateAssetInput = z.infer<typeof updateAssetSchema>;
type UpdateAssetStockInput = z.infer<typeof updateAssetStockSchema>;
type ListFilamentReferencesQuery = z.infer<typeof listFilamentReferencesQuerySchema>;
type ListAssetHistoryQuery = z.infer<typeof listAssetHistoryQuerySchema>;
type SplitSpoolInput = z.infer<typeof splitSpoolSchema>;

type AssetRow = {
  asset_id: string;
  company_id: string;
  asset_type: "filament_spool" | "nozzle" | "resin_tank";
  filament_ref_id: string | null;
  parent_asset_id: string | null;
  split_at: string | null;
  child_spool_count: string | null;
  initial_grams: string | null;
  purchase_price: string | null;
  purchase_date: string | null;
  production_date: string | null;
  nozzle_diameter_mm: string | null;
  nozzle_material: string | null;
  nozzle_max_temp: number | null;
  nozzle_name: string | null;
  nozzle_brand: string | null;
  resin_brand: string | null;
  resin_type: string | null;
  resin_color: string | null;
  resin_hex: string | null;
  resin_uv_wavelength_nm: number | null;
  resin_uv_reactive: boolean;
  resin_density: string | null;
  resin_initial_volume_ml: string | null;
  resin_purchase_date: string | null;
  resin_production_date: string | null;
  location: string | null;
  marker: string | null;
  notes: string | null;
  created_at: string;
  stock_status: string;
  remaining_grams: string | null;
  remaining_volume_ml: string | null;
  reserved_grams: string | null;
  reserved_volume_ml: string | null;
  free_grams: string | null;
  free_volume_ml: string | null;
  currently_used_in_piece_id: string | null;
  in_use_since: string | null;
  installed_on_asset_id: string | null;
  next_free_at: string | null;
  stock_last_updated_at: string;
  filament_brand: string | null;
  filament_material_type: string | null;
  filament_color: string | null;
  filament_diameter: string | null;
  filament_source_type: string | null;
  filament_melting_temp: number | null;
  filament_max_print_speed_mm_s: number | null;
  filament_hex: string | null;
  filament_density: string | null;
  filament_bed_temp: number | null;
  filament_bed_temp_range: number[] | null;
  filament_extruder_temp_range: number[] | null;
  filament_finish: string | null;
  filament_fill: string | null;
  filament_pattern: string | null;
  filament_multi_color_direction: string | null;
  filament_translucent: boolean | null;
  filament_glow: boolean | null;
  filament_description: string | null;
  filament_notes: string | null;
};

@Injectable()
export class AssetsService {
  private readonly logger = new Logger(AssetsService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly financeService: FinanceService
  ) {}

  async listFilamentReferences(query: ListFilamentReferencesQuery) {
    const values: unknown[] = [];
    const filters: string[] = [];

    if (query.brand) {
      values.push(query.brand);
      filters.push(`brand = $${values.length}`);
    }

    if (query.material_type) {
      values.push(query.material_type);
      filters.push(`material_type = $${values.length}`);
    }

    if (query.search) {
      values.push(`%${query.search}%`);
      filters.push(
        `(brand ILIKE $${values.length} OR material_type ILIKE $${values.length} OR color ILIKE $${values.length})`
      );
    }

    const whereClause =
      filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

    const result = await this.databaseService.query(
      `
        SELECT
          filament_ref_id,
          brand,
          material_type,
          color,
          diameter,
          melting_temp,
          max_print_speed_mm_s,
          hex,
          density,
          bed_temp,
          bed_temp_range,
          extruder_temp_range,
          finish,
          fill,
          pattern,
          multi_color_direction,
          translucent,
          glow,
          description,
          notes,
          source_type,
          company_id,
          created_by_company_id
        FROM filament_reference
        ${whereClause}
        ORDER BY brand, material_type, color
      `,
      values
    );

    return result.rows;
  }

  async createFilamentReference(
    companyId: string,
    input: FilamentReferenceInput,
    executor?: SqlExecutor
  ) {
    const existing = await this.databaseService.query<{ filament_ref_id: string }>(
      `
        SELECT filament_ref_id
        FROM filament_reference
        WHERE lower(brand) = lower($1)
          AND lower(material_type) = lower($2)
          AND lower(color) = lower($3)
          AND diameter = $4
        LIMIT 1
      `,
      [input.brand, input.material_type, input.color, input.diameter],
      executor
    );

    const existingRow = existing.rows[0];

    if (existingRow) {
      return this.getFilamentReferenceById(existingRow.filament_ref_id, executor);
    }

    const created = await this.databaseService.query<{ filament_ref_id: string }>(
      `
        INSERT INTO filament_reference (
          company_id,
          created_by_company_id,
          brand,
          material_type,
          color,
          diameter,
          melting_temp,
          max_print_speed_mm_s,
          hex,
          density,
          bed_temp,
          bed_temp_range,
          extruder_temp_range,
          finish,
          fill,
          pattern,
          multi_color_direction,
          translucent,
          glow,
          description,
          notes,
          source_type
        )
        VALUES (
          NULL,
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12,
          $13,
          $14,
          $15,
          $16,
          $17,
          $18,
          $19,
          $20,
          'global_custom'
        )
        RETURNING filament_ref_id
      `,
      [
        companyId,
        input.brand,
        input.material_type,
        input.color,
        input.diameter,
        input.melting_temp ?? null,
        input.max_print_speed_mm_s ?? null,
        input.hex ?? null,
        input.density ?? null,
        input.bed_temp ?? null,
        input.bed_temp_range ?? null,
        input.extruder_temp_range ?? null,
        input.finish ?? null,
        input.fill ?? null,
        input.pattern ?? null,
        input.multi_color_direction ?? null,
        input.translucent ?? false,
        input.glow ?? false,
        input.description ?? null,
        input.notes ?? null
      ],
      executor
    );

    const createdRow = created.rows[0];

    if (!createdRow) {
      throw new BadRequestException("Filament reference insert failed.");
    }

    return this.getFilamentReferenceById(createdRow.filament_ref_id, executor);
  }

  // Physical filament-spool inventory: one row per spool, with remaining/
  // reserved grams + a readable filament label. Two spools of the same
  // reference yield two rows (distinct asset_id).
  async listSpoolInventory(companyId: string) {
    const res = await this.databaseService.query<{
      asset_id: string;
      filament_ref_id: string | null;
      remaining_grams: string | null;
      reserved_grams: string | null;
      initial_grams: string | null;
      status: string;
      brand: string | null;
      material_type: string | null;
      color: string | null;
      location: string | null;
      marker: string | null;
    }>(
      `SELECT ai.asset_id, ai.filament_ref_id, ai.initial_grams, ai.purchase_price, ai.location, ai.marker,
              COALESCE(ast.remaining_grams, ai.initial_grams) AS remaining_grams,
              COALESCE(ast.reserved_grams, 0)                 AS reserved_grams,
              COALESCE(ast.status, 'available')               AS status,
              fr.brand, fr.material_type, fr.color
         FROM asset_instances ai
         LEFT JOIN asset_stock ast ON ast.asset_id = ai.asset_id
         LEFT JOIN filament_reference fr ON fr.filament_ref_id = ai.filament_ref_id
        WHERE ai.company_id = $1 AND ai.asset_type = 'filament_spool'
          -- A distributed (split) parent is unusable for new assignments; only
          -- its children carry the real, allocatable grams.
          AND ai.split_at IS NULL
        ORDER BY fr.brand NULLS LAST, fr.material_type, fr.color, ai.created_at`,
      [companyId]
    );
    return res.rows.map((r) => {
      const remaining = r.remaining_grams != null ? Number(r.remaining_grams) : null;
      const reserved = Number(r.reserved_grams ?? 0);
      const baseLabel = [r.brand, r.material_type].filter(Boolean).join(" ") + (r.color ? ` / ${r.color}` : "");
      const label = (baseLabel.trim() || "Unknown filament") + (r.location ? ` · ${r.location}` : "");
      return {
        asset_id: r.asset_id,
        filament_ref_id: r.filament_ref_id,
        material_type: r.material_type,
        color: r.color,
        location: r.location,
        marker: r.marker,
        label,
        remaining_grams: remaining,
        reserved_grams: reserved,
        free_grams: remaining != null ? Math.max(0, remaining - reserved) : null,
        initial_grams: r.initial_grams != null ? Number(r.initial_grams) : null,
        status: r.status,
      };
    });
  }

  // Average filament price per gram for each material type:
  //   Σ(purchase_price) / Σ(initial_grams)
  // counting ONLY spools that have a positive price (so free/0-priced spools
  // don't drag the average down). All priced spools count, regardless of age.
  // Child spools (parent_asset_id IS NOT NULL) are excluded — a split keeps the
  // original parent as the priced spool, so it must never re-count its grams.
  async listMaterialPricing(companyId: string) {
    const res = await this.databaseService.query<{
      material_type: string;
      avg_price_per_gram: string | null;
    }>(
      `SELECT fr.material_type,
              SUM(ai.purchase_price) / NULLIF(SUM(ai.initial_grams), 0) AS avg_price_per_gram
         FROM asset_instances ai
         JOIN filament_reference fr ON fr.filament_ref_id = ai.filament_ref_id
        WHERE ai.company_id = $1
          AND ai.asset_type = 'filament_spool'
          AND ai.parent_asset_id IS NULL
          AND ai.purchase_price > 0
          AND ai.initial_grams > 0
          AND fr.material_type IS NOT NULL
        GROUP BY fr.material_type`,
      [companyId]
    );
    return res.rows
      .filter((r) => r.avg_price_per_gram != null)
      .map((r) => ({
        material_type: r.material_type,
        avg_price_per_gram: Number(r.avg_price_per_gram)
      }));
  }

  // ── Assets overview (dashboard aggregations) ───────────────────────────────
  // One round-trip for the Assets → Overview tab. Everything is derived from
  // live inventory/schedule tables with the same conventions used elsewhere:
  // split parents are excluded from filament totals (their grams live on the
  // children), print hours = COALESCE(actual, slicer) minutes on 'done'
  // pieces/beds, and a nozzle counts as installed when a printer mounts it.
  // Filament-on-hand/nozzle-rack are point-in-time inventory snapshots (a
  // period selector wouldn't mean anything there); printer hours and nozzle
  // "most used" are genuine period windows, sized by `period`.
  async getAssetsOverview(companyId: string, period: "week" | "month" | "year" | "all") {
    const num = (v: unknown) => (v == null ? 0 : Number(v));
    // "all" uses a ~100y window as a practical stand-in for "unbounded" so the
    // query stays one shape; the previous-period comparison is meaningless at
    // that scale, so the client suppresses the delta chip when period="all".
    const days = { week: 7, month: 30, year: 365, all: 36500 }[period];

    const [
      filamentByColor,
      consumedByMaterial,
      nozzleSpecs,
      nozzleUsage,
      printerFleet,
      printHours,
      topPrinters,
      wasteByMaterial,
      wasteTotals
    ] = await Promise.all([
      // Filament on hand, per material+color (hex kept for swatches). The
      // client rolls colors up into per-material totals.
      this.databaseService.query<{
        material_type: string | null;
        color: string | null;
        hex: string | null;
        spool_count: string;
        remaining_grams: string;
        reserved_grams: string;
      }>(
        `SELECT fr.material_type,
                fr.color,
                MAX(fr.hex) AS hex,
                COUNT(*)::int AS spool_count,
                COALESCE(SUM(COALESCE(ast.remaining_grams, ai.initial_grams)), 0) AS remaining_grams,
                COALESCE(SUM(COALESCE(ast.reserved_grams, 0)), 0) AS reserved_grams
           FROM asset_instances ai
           JOIN asset_stock ast ON ast.asset_id = ai.asset_id
           LEFT JOIN filament_reference fr ON fr.filament_ref_id = ai.filament_ref_id
          WHERE ai.company_id = $1
            AND ai.asset_type = 'filament_spool'
            AND ai.split_at IS NULL
          GROUP BY fr.material_type, fr.color
          ORDER BY remaining_grams DESC`,
        [companyId]
      ),
      // Most-used material = grams actually burned (initial - remaining) on
      // live spools. Split parents excluded — their depletion is distribution,
      // not consumption; the children carry the real burn.
      this.databaseService.query<{ material_type: string; consumed_grams: string }>(
        `SELECT fr.material_type,
                COALESCE(SUM(GREATEST(ai.initial_grams - COALESCE(ast.remaining_grams, ai.initial_grams), 0)), 0) AS consumed_grams
           FROM asset_instances ai
           JOIN asset_stock ast ON ast.asset_id = ai.asset_id
           JOIN filament_reference fr ON fr.filament_ref_id = ai.filament_ref_id
          WHERE ai.company_id = $1
            AND ai.asset_type = 'filament_spool'
            AND ai.split_at IS NULL
            AND fr.material_type IS NOT NULL
          GROUP BY fr.material_type
         HAVING SUM(GREATEST(ai.initial_grams - COALESCE(ast.remaining_grams, ai.initial_grams), 0)) > 0
          ORDER BY consumed_grams DESC`,
        [companyId]
      ),
      // Nozzle rack: counts per material+diameter spec, with live installed
      // (mounted on a printer) and damaged breakdowns.
      this.databaseService.query<{
        nozzle_material: string | null;
        nozzle_diameter_mm: string | null;
        count: string;
        installed_count: string;
        damaged_count: string;
      }>(
        `SELECT ai.nozzle_material,
                ai.nozzle_diameter_mm,
                COUNT(*)::int AS count,
                COUNT(*) FILTER (
                  WHERE EXISTS (SELECT 1 FROM printer_stock ps WHERE ps.current_nozzle_asset_id = ai.asset_id)
                )::int AS installed_count,
                COUNT(*) FILTER (WHERE ast.status = 'damaged')::int AS damaged_count
           FROM asset_instances ai
           JOIN asset_stock ast ON ast.asset_id = ai.asset_id
          WHERE ai.company_id = $1
            AND ai.asset_type = 'nozzle'
          GROUP BY ai.nozzle_material, ai.nozzle_diameter_mm
          ORDER BY count DESC, ai.nozzle_diameter_mm`,
        [companyId]
      ),
      // Most-used nozzle spec = completed prints within the window (same
      // "actually did work" definition as printer hours below).
      this.databaseService.query<{
        nozzle_material: string | null;
        nozzle_diameter_mm: string | null;
        assignment_count: string;
      }>(
        `SELECT noz.nozzle_material,
                noz.nozzle_diameter_mm,
                COUNT(*)::int AS assignment_count
           FROM order_pieces op
           JOIN asset_instances noz ON noz.asset_id = op.assigned_nozzle_asset_id
          WHERE op.company_id = $1
            AND op.status = 'done'
            AND op.print_completed_at >= now() - ($2 || ' days')::interval
          GROUP BY noz.nozzle_material, noz.nozzle_diameter_mm
          ORDER BY assignment_count DESC
          LIMIT 5`,
        [companyId, days]
      ),
      // Printer fleet status right now (live in-use, same rule the printers
      // list uses: a printing standalone piece or a printing bed).
      this.databaseService.query<{
        total: string;
        printing_now: string;
        maintenance: string;
        offline: string;
      }>(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (
                  WHERE EXISTS (
                          SELECT 1 FROM order_pieces op
                           WHERE op.assigned_printer_id = pi.printer_id AND op.company_id = pi.company_id
                             AND op.bed_id IS NULL AND op.status = 'printing')
                     OR EXISTS (
                          SELECT 1 FROM print_beds pb
                           WHERE pb.assigned_printer_id = pi.printer_id AND pb.company_id = pi.company_id
                             AND pb.status = 'printing')
                )::int AS printing_now,
                COUNT(*) FILTER (WHERE ps.is_under_maintenance)::int AS maintenance,
                COUNT(*) FILTER (WHERE ps.is_offline AND NOT ps.is_under_maintenance)::int AS offline
           FROM printer_instances pi
           JOIN printer_stock ps ON ps.printer_id = pi.printer_id
          WHERE pi.company_id = $1`,
        [companyId]
      ),
      // Worked hours: the selected window, the equal-length window before it
      // (for the delta chip), and all-time accumulated print hours + a
      // window-scoped completed-print count.
      this.databaseService.query<{
        hours_period: string | null;
        hours_prev_period: string | null;
        hours_all: string | null;
        prints_period: string;
      }>(
        `WITH prints AS (
           SELECT COALESCE(op.actual_print_time_minutes, op.slicer_print_time_minutes, 0) AS mins,
                  op.print_completed_at AS done_at
             FROM order_pieces op
            WHERE op.company_id = $1 AND op.bed_id IS NULL AND op.status = 'done'
              AND op.assigned_printer_id IS NOT NULL
           UNION ALL
           SELECT COALESCE(pb.actual_print_time_minutes, pb.slicer_print_time_minutes, 0),
                  pb.print_completed_at
             FROM print_beds pb
            WHERE pb.company_id = $1 AND pb.status = 'done'
              AND pb.assigned_printer_id IS NOT NULL
         )
         SELECT ROUND(COALESCE(SUM(mins) FILTER (WHERE done_at >= now() - ($2 || ' days')::interval), 0)::numeric / 60.0, 1) AS hours_period,
                ROUND(COALESCE(SUM(mins) FILTER (WHERE done_at >= now() - ($3 || ' days')::interval
                                                   AND done_at <  now() - ($2 || ' days')::interval), 0)::numeric / 60.0, 1) AS hours_prev_period,
                ROUND(COALESCE(SUM(mins), 0)::numeric / 60.0, 1) AS hours_all,
                COUNT(*) FILTER (WHERE done_at >= now() - ($2 || ' days')::interval)::int AS prints_period
           FROM prints`,
        [companyId, days, days * 2]
      ),
      // Busiest printers within the window (top 3, for the workload bars).
      this.databaseService.query<{
        printer_id: string;
        label: string | null;
        hours: string;
      }>(
        `WITH prints AS (
           SELECT op.assigned_printer_id AS printer_id,
                  COALESCE(op.actual_print_time_minutes, op.slicer_print_time_minutes, 0) AS mins
             FROM order_pieces op
            WHERE op.company_id = $1 AND op.bed_id IS NULL AND op.status = 'done'
              AND op.assigned_printer_id IS NOT NULL
              AND op.print_completed_at >= now() - ($2 || ' days')::interval
           UNION ALL
           SELECT pb.assigned_printer_id,
                  COALESCE(pb.actual_print_time_minutes, pb.slicer_print_time_minutes, 0)
             FROM print_beds pb
            WHERE pb.company_id = $1 AND pb.status = 'done'
              AND pb.assigned_printer_id IS NOT NULL
              AND pb.print_completed_at >= now() - ($2 || ' days')::interval
         )
         SELECT p.printer_id,
                COALESCE(
                  NULLIF(TRIM(COALESCE(pi.brand, pr.brand, '') || ' ' || COALESCE(pi.model, pr.model, '')), ''),
                  pi.serial_number,
                  'Printer') AS label,
                ROUND(SUM(p.mins)::numeric / 60.0, 1) AS hours
           FROM prints p
           JOIN printer_instances pi ON pi.printer_id = p.printer_id
           LEFT JOIN printer_reference pr ON pr.printer_ref_id = pi.printer_ref_id
          GROUP BY p.printer_id, pi.brand, pi.model, pr.brand, pr.model, pi.serial_number
         HAVING SUM(p.mins) > 0
          ORDER BY SUM(p.mins) DESC
          LIMIT 3`,
        [companyId, days]
      ),
      // Filament wasted per material within the window (measured failed-print
      // scrap), valued at the cost snapshotted when each loss was recorded.
      this.databaseService.query<{ material_type: string | null; grams: string; cost: string }>(
        `SELECT material_type,
                COALESCE(SUM(grams), 0) AS grams,
                COALESCE(SUM(cost), 0)  AS cost
           FROM filament_waste_events
          WHERE company_id = $1
            AND created_at >= now() - ($2 || ' days')::interval
          GROUP BY material_type
         HAVING SUM(grams) > 0
          ORDER BY cost DESC, grams DESC`,
        [companyId, days]
      ),
      // Waste roll-up: the window total, the equal window before it (delta
      // chip) and the all-time total, in one scan.
      this.databaseService.query<{
        grams_period: string;
        cost_period: string;
        events_period: string;
        cost_prev_period: string;
        grams_lifetime: string;
        cost_lifetime: string;
      }>(
        `SELECT
           COALESCE(SUM(grams) FILTER (WHERE created_at >= now() - ($2 || ' days')::interval), 0) AS grams_period,
           COALESCE(SUM(cost)  FILTER (WHERE created_at >= now() - ($2 || ' days')::interval), 0) AS cost_period,
           COUNT(*) FILTER (WHERE created_at >= now() - ($2 || ' days')::interval)::int          AS events_period,
           COALESCE(SUM(cost)  FILTER (WHERE created_at >= now() - ($3 || ' days')::interval
                                         AND created_at <  now() - ($2 || ' days')::interval), 0) AS cost_prev_period,
           COALESCE(SUM(grams), 0) AS grams_lifetime,
           COALESCE(SUM(cost), 0)  AS cost_lifetime
         FROM filament_waste_events
        WHERE company_id = $1`,
        [companyId, days, days * 2]
      )
    ]);

    const hoursRow = printHours.rows[0];
    const fleetRow = printerFleet.rows[0];

    return {
      filament: {
        by_color: filamentByColor.rows.map((r) => ({
          material_type: r.material_type,
          color: r.color,
          hex: r.hex,
          spool_count: num(r.spool_count),
          remaining_grams: num(r.remaining_grams),
          reserved_grams: num(r.reserved_grams)
        })),
        consumed_by_material: consumedByMaterial.rows.map((r) => ({
          material_type: r.material_type,
          consumed_grams: num(r.consumed_grams)
        }))
      },
      waste: {
        by_material: wasteByMaterial.rows.map((r) => ({
          material_type: r.material_type,
          grams: num(r.grams),
          cost: num(r.cost)
        })),
        grams_period: num(wasteTotals.rows[0]?.grams_period),
        cost_period: num(wasteTotals.rows[0]?.cost_period),
        events_period: num(wasteTotals.rows[0]?.events_period),
        cost_prev_period: num(wasteTotals.rows[0]?.cost_prev_period),
        grams_lifetime: num(wasteTotals.rows[0]?.grams_lifetime),
        cost_lifetime: num(wasteTotals.rows[0]?.cost_lifetime)
      },
      nozzles: {
        by_spec: nozzleSpecs.rows.map((r) => ({
          nozzle_material: r.nozzle_material,
          nozzle_diameter_mm: r.nozzle_diameter_mm != null ? Number(r.nozzle_diameter_mm) : null,
          count: num(r.count),
          installed_count: num(r.installed_count),
          damaged_count: num(r.damaged_count)
        })),
        most_used: nozzleUsage.rows.map((r) => ({
          nozzle_material: r.nozzle_material,
          nozzle_diameter_mm: r.nozzle_diameter_mm != null ? Number(r.nozzle_diameter_mm) : null,
          assignment_count: num(r.assignment_count)
        }))
      },
      printers: {
        total: num(fleetRow?.total),
        printing_now: num(fleetRow?.printing_now),
        maintenance: num(fleetRow?.maintenance),
        offline: num(fleetRow?.offline),
        hours_period: num(hoursRow?.hours_period),
        hours_prev_period: num(hoursRow?.hours_prev_period),
        hours_all: num(hoursRow?.hours_all),
        prints_period: num(hoursRow?.prints_period),
        top_printers_period: topPrinters.rows.map((r) => ({
          printer_id: r.printer_id,
          label: r.label ?? "Printer",
          hours: num(r.hours)
        }))
      }
    };
  }

  async listAssets(companyId: string, query: ListAssetsQuery) {
    const values: unknown[] = [companyId];
    const filters = ["ai.company_id = $1"];

    if (query.asset_type) {
      values.push(query.asset_type);
      filters.push(`ai.asset_type = $${values.length}`);
    }

    if (query.status) {
      values.push(query.status);
      filters.push(`ast.status = $${values.length}`);
    }

    if (query.search) {
      values.push(`%${query.search}%`);
      filters.push(`
        (
          ai.notes ILIKE $${values.length}
          OR ai.location ILIKE $${values.length}
          OR ai.marker ILIKE $${values.length}
          OR ai.asset_id::text ILIKE $${values.length}
          OR upper(substr(replace(ai.asset_id::text, '-', ''), 1, 8)) ILIKE replace(upper($${values.length}), '-', '')
          OR fr.brand ILIKE $${values.length}
          OR fr.material_type ILIKE $${values.length}
          OR fr.color ILIKE $${values.length}
          OR ai.nozzle_material ILIKE $${values.length}
          OR ai.nozzle_name ILIKE $${values.length}
          OR ai.nozzle_brand ILIKE $${values.length}
          OR ai.resin_brand ILIKE $${values.length}
          OR ai.resin_type ILIKE $${values.length}
        )
      `);
    }

    const result = await this.databaseService.query<AssetRow>(
      `
        ${this.assetSelectSql()}
        WHERE ${filters.join(" AND ")}
        ORDER BY ai.created_at DESC
      `,
      values
    );

    return result.rows;
  }

  async getAssetById(
    companyId: string,
    assetId: string,
    executor?: SqlExecutor
  ): Promise<AssetRow> {
    const result = await this.databaseService.query<AssetRow>(
      `
        ${this.assetSelectSql()}
        WHERE ai.company_id = $1
          AND ai.asset_id = $2
      `,
      [companyId, assetId],
      executor
    );

    if (!result.rowCount) {
      throw new NotFoundException("Asset not found.");
    }

    const row = result.rows[0];

    if (!row) {
      throw new NotFoundException("Asset not found.");
    }

    return row;
  }

  async createSpool(companyId: string, userId: string, input: CreateSpoolInput) {
    const spools = await this.databaseService.transaction(async (client) => {
      const resolvedReference = input.filament_ref_id
        ? input.filament_ref_id
        : (
            await this.createFilamentReference(
              companyId,
              input.custom_reference!,
              client
            )
          );

      const filamentRefId =
        typeof resolvedReference === "string"
          ? resolvedReference
          : resolvedReference.filament_ref_id;

      // Multiplier: create N identical spool instances from one submission. The
      // filament reference is resolved once above and shared by all of them, so a
      // custom reference isn't duplicated per spool.
      const quantity = input.quantity ?? 1;
      const createdAssetIds: string[] = [];

      for (let i = 0; i < quantity; i++) {
        const createdAsset = await this.databaseService.query<{ asset_id: string }>(
          `
            INSERT INTO asset_instances (
              company_id,
              asset_type,
              filament_ref_id,
              initial_grams,
              purchase_price,
              purchase_date,
              production_date,
              location,
              marker,
              notes
            )
            VALUES ($1, 'filament_spool', $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING asset_id
          `,
          [
            companyId,
            filamentRefId,
            input.initial_grams,
            input.purchase_price ?? null,
            input.purchase_date ?? null,
            input.production_date ?? null,
            input.location ?? null,
            input.marker ?? null,
            input.notes ?? null
          ],
          client
        );

        const createdAssetRow = createdAsset.rows[0];

        if (!createdAssetRow) {
          throw new BadRequestException("Spool insert failed.");
        }

        await this.databaseService.query(
          `
            INSERT INTO asset_stock (
              asset_id,
              company_id,
              status,
              remaining_grams,
              remaining_volume_ml,
              currently_used_in_piece_id,
              in_use_since,
              installed_on_asset_id,
              next_free_at
            )
            VALUES ($1, $2, 'available', $3, NULL, NULL, NULL, NULL, NULL)
          `,
          [createdAssetRow.asset_id, companyId, input.initial_grams],
          client
        );

        await this.logAssetEvent(
          companyId,
          createdAssetRow.asset_id,
          "filament_spool",
          "addition",
          "New Filament Spool",
          quantity > 1
            ? `New spool added to inventory (${i + 1} of ${quantity})`
            : "New spool added to inventory",
          client
        );

        createdAssetIds.push(createdAssetRow.asset_id);
      }

      const createdAssets = await Promise.all(
        createdAssetIds.map((id) => this.getAssetById(companyId, id, client))
      );

      return createdAssets;
    });

    // Assets → Finance: best-effort, post-commit. A finance hiccup must never
    // undo the spools the operator just added, so failures are logged, not thrown.
    await this.recordSpoolPurchaseInFinance(companyId, userId, input, spools);

    // Stay backwards-compatible: a single spool returns the asset object, while
    // a multiplier batch returns the array of created spools.
    return (input.quantity ?? 1) > 1 ? spools : spools[0];
  }

  // Book the just-added spool(s) as an itemized filament-purchase bill in
  // Finance. Only fires when a vendor name was supplied and there is something
  // billable (a spool price and/or a delivery cost). The spool line's quantity is
  // the ×N multiplier, so a "box of 4" reads as one line of qty 4. Best-effort:
  // any failure (e.g. books locked for that date) is logged and swallowed so the
  // physical inventory the operator created is never rolled back.
  private async recordSpoolPurchaseInFinance(
    companyId: string,
    userId: string,
    input: CreateSpoolInput,
    spools: AssetRow[]
  ): Promise<void> {
    const vendorName = input.vendor_name?.trim();
    if (!vendorName) return;

    const unitPrice = input.purchase_price ?? 0;
    const deliveryCost = input.delivery_cost ?? 0;
    if (unitPrice <= 0 && deliveryCost <= 0) return;

    const first = spools[0];
    const label =
      [first?.filament_brand, first?.filament_material_type, first?.filament_color]
        .filter(Boolean)
        .join(" ")
        .trim() || "Filament spool";
    const grams = input.initial_grams;
    const description = grams ? `${label} — spool (${grams} g)` : `${label} — spool`;
    // Cross-reference the created inventory rows so the bill is traceable back to
    // the physical spools (and vice-versa via the vendor_reference column).
    const reference = spools.length
      ? `Spool ${spools.map((s) => s.asset_id).join(", ")}`.slice(0, 200)
      : null;

    try {
      const result = await this.financeService.recordFilamentPurchase(companyId, userId, {
        vendorName,
        description,
        unitPrice,
        quantity: input.quantity ?? 1,
        deliveryCost,
        priceIncludesTax: input.price_includes_tax ?? false,
        alreadyPaid: input.already_paid ?? false,
        purchaseDate: input.purchase_date ?? null,
        reference
      });
      if (result) {
        this.logger.log(
          `Recorded filament purchase ${result.bill_number} (${result.status}) for company ${companyId}.`
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to auto-record filament purchase for company ${companyId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  // Split one idle spool into N child spools. The parent is kept intact but
  // marked distributed (split_at) so it's unusable for new assignments, while
  // the children become the real, allocatable spools. Eligibility: a filament
  // spool that isn't already split/child, isn't in use, has no reservation and
  // no scheduled commitment, and has remaining grams to divide. The per-child
  // grams must sum to the parent's current remaining grams.
  async splitSpool(companyId: string, assetId: string, input: SplitSpoolInput) {
    return this.databaseService.transaction(async (client) => {
      const parent = await this.getAssetById(companyId, assetId, client);

      if (parent.asset_type !== "filament_spool") {
        throw new BadRequestException("Only filament spools can be split.");
      }
      if (parent.split_at) {
        throw new BadRequestException("This spool has already been split.");
      }
      // A child spool is otherwise a normal spool — it may be split again. Any
      // descendant keeps a non-null parent_asset_id, so it stays excluded from
      // cost averaging and the original top parent remains the only priced spool.
      if (parent.currently_used_in_piece_id) {
        throw new BadRequestException("Cannot split a spool that is currently in use.");
      }
      if (Number(parent.reserved_grams ?? 0) > 0) {
        throw new BadRequestException("Cannot split a spool that has reserved grams.");
      }

      const commitments = await client.query(
        `SELECT 1 FROM order_piece_spools
          WHERE company_id = $1 AND spool_asset_id = $2 LIMIT 1`,
        [companyId, assetId]
      );
      if (commitments.rowCount) {
        throw new BadRequestException(
          "Cannot split a spool that is reserved for scheduled work."
        );
      }

      const remaining = parent.remaining_grams != null ? Number(parent.remaining_grams) : null;
      if (remaining == null || !Number.isFinite(remaining) || remaining <= 0) {
        throw new BadRequestException("This spool has no remaining grams to split.");
      }

      const sum = input.children.reduce((acc, g) => acc + g, 0);
      // Half-gram tolerance absorbs the rounding of an even distribution.
      if (Math.abs(sum - remaining) > 0.5) {
        throw new BadRequestException(
          `Child grams must sum to the spool's current ${remaining} g (got ${Math.round(sum * 100) / 100} g).`
        );
      }

      const parentName = this.buildAssetName(parent);
      const total = input.children.length;

      for (let i = 0; i < total; i++) {
        const grams = input.children[i]!;
        const createdAsset = await client.query<{ asset_id: string }>(
          `
            INSERT INTO asset_instances (
              company_id, asset_type, filament_ref_id, parent_asset_id,
              initial_grams, purchase_price, purchase_date, production_date,
              location, notes
            )
            VALUES ($1, 'filament_spool', $2, $3, $4, NULL, $5, $6, $7, $8)
            RETURNING asset_id
          `,
          [
            companyId,
            parent.filament_ref_id,
            assetId,
            grams,
            parent.purchase_date,
            parent.production_date,
            parent.location,
            `Split from parent spool ${assetId} (${i + 1} of ${total})`
          ]
        );

        const childRow = createdAsset.rows[0];
        if (!childRow) {
          throw new BadRequestException("Child spool insert failed.");
        }

        await client.query(
          `
            INSERT INTO asset_stock (
              asset_id, company_id, status, remaining_grams, remaining_volume_ml,
              currently_used_in_piece_id, in_use_since, installed_on_asset_id, next_free_at
            )
            VALUES ($1, $2, 'available', $3, NULL, NULL, NULL, NULL, NULL)
          `,
          [childRow.asset_id, companyId, grams]
        );

        await this.logAssetEvent(
          companyId,
          childRow.asset_id,
          "filament_spool",
          "addition",
          parentName,
          `Child spool from split (${grams} g)`,
          client
        );
      }

      // Flag the parent distributed/unusable and empty its current grams — the
      // physical filament now lives on the children. Its initial_grams +
      // purchase_price are untouched, so it stays the spool counted in cost
      // averaging. Mirror the depleted-spool convention (status → 'empty').
      await client.query(
        `UPDATE asset_instances SET split_at = now() WHERE company_id = $1 AND asset_id = $2`,
        [companyId, assetId]
      );
      await client.query(
        `UPDATE asset_stock
            SET remaining_grams = 0,
                reserved_grams  = 0,
                status          = 'empty'
          WHERE company_id = $1 AND asset_id = $2`,
        [companyId, assetId]
      );

      await this.logAssetEvent(
        companyId,
        assetId,
        "filament_spool",
        "edit",
        parentName,
        `Split into ${total} child spools`,
        client
      );

      return this.getAssetById(companyId, assetId, client);
    });
  }

  async createNozzle(companyId: string, input: CreateNozzleInput) {
    return this.databaseService.transaction(async (client) => {
      // Multiplier: create N identical nozzle instances from one submission
      // (same convention as spools — each becomes its own inventory row).
      const quantity = input.quantity ?? 1;
      const nozzleName =
        input.nozzle_name ??
        `${input.nozzle_material} ${input.nozzle_diameter_mm}mm Nozzle`;
      const createdAssetIds: string[] = [];

      for (let i = 0; i < quantity; i++) {
        const createdAsset = await this.databaseService.query<{ asset_id: string }>(
          `
            INSERT INTO asset_instances (
              company_id,
              asset_type,
              nozzle_name,
              nozzle_brand,
              nozzle_diameter_mm,
              nozzle_material,
              nozzle_max_temp,
              purchase_price,
              location,
              notes
            )
            VALUES ($1, 'nozzle', $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING asset_id
          `,
          [
            companyId,
            input.nozzle_name ?? null,
            input.nozzle_brand ?? null,
            input.nozzle_diameter_mm,
            input.nozzle_material,
            input.nozzle_max_temp ?? null,
            input.purchase_price ?? null,
            input.location ?? null,
            input.notes ?? null
          ],
          client
        );

        const createdAssetRow = createdAsset.rows[0];

        if (!createdAssetRow) {
          throw new BadRequestException("Nozzle insert failed.");
        }

        await this.databaseService.query(
          `
            INSERT INTO asset_stock (
              asset_id,
              company_id,
              status,
              remaining_grams,
              remaining_volume_ml,
              currently_used_in_piece_id,
              in_use_since,
              installed_on_asset_id,
              next_free_at
            )
            VALUES ($1, $2, 'available', NULL, NULL, NULL, NULL, NULL, NULL)
          `,
          [createdAssetRow.asset_id, companyId],
          client
        );

        await this.logAssetEvent(
          companyId,
          createdAssetRow.asset_id,
          "nozzle",
          "addition",
          nozzleName,
          quantity > 1
            ? `New nozzle added to inventory (${i + 1} of ${quantity})`
            : "New nozzle added to inventory",
          client
        );

        createdAssetIds.push(createdAssetRow.asset_id);
      }

      const createdAssets = await Promise.all(
        createdAssetIds.map((id) => this.getAssetById(companyId, id, client))
      );

      // Same backwards-compat convention as spools: single create returns the
      // asset object, a multiplier batch returns the array.
      return quantity > 1 ? createdAssets : createdAssets[0];
    });
  }

  async createResinTank(companyId: string, input: CreateResinTankInput) {
    return this.databaseService.transaction(async (client) => {
      const createdAsset = await this.databaseService.query<{ asset_id: string }>(
        `
          INSERT INTO asset_instances (
            company_id,
            asset_type,
            resin_brand,
            resin_type,
            resin_color,
            resin_hex,
            resin_uv_wavelength_nm,
            resin_uv_reactive,
            resin_density,
            resin_initial_volume_ml,
            resin_purchase_date,
            resin_production_date,
            location,
            notes
          )
          VALUES ($1, 'resin_tank', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          RETURNING asset_id
        `,
        [
          companyId,
          input.resin_brand,
          input.resin_type,
          input.resin_color ?? null,
          input.resin_hex ?? null,
          input.resin_uv_wavelength_nm ?? null,
          input.resin_uv_reactive ?? false,
          input.resin_density ?? null,
          input.resin_initial_volume_ml,
          input.resin_purchase_date ?? null,
          input.resin_production_date ?? null,
          input.location ?? null,
          input.notes ?? null
        ],
        client
      );

      const createdAssetRow = createdAsset.rows[0];

      if (!createdAssetRow) {
        throw new BadRequestException("Resin tank insert failed.");
      }

      await this.databaseService.query(
        `
          INSERT INTO asset_stock (
            asset_id,
            company_id,
            status,
            remaining_grams,
            remaining_volume_ml,
            currently_used_in_piece_id,
            in_use_since,
            installed_on_asset_id,
            next_free_at
          )
          VALUES ($1, $2, 'available', NULL, $3, NULL, NULL, NULL, NULL)
        `,
        [createdAssetRow.asset_id, companyId, input.resin_initial_volume_ml],
        client
      );

      await this.logAssetEvent(
        companyId,
        createdAssetRow.asset_id,
        "resin_tank",
        "addition",
        `${input.resin_brand} ${input.resin_type} ${input.resin_color ?? ""} Tank`.trim(),
        "New resin tank added to inventory",
        client
      );

      return this.getAssetById(companyId, createdAssetRow.asset_id, client);
    });
  }

  async updateAsset(companyId: string, assetId: string, input: UpdateAssetInput) {
    const asset = await this.getAssetById(companyId, assetId);

    const allowedColumnsByType = {
      filament_spool: [
        "initial_grams",
        "purchase_price",
        "purchase_date",
        "production_date",
        "location",
        "marker",
        "notes"
      ],
      nozzle: [
        "nozzle_diameter_mm",
        "nozzle_material",
        "nozzle_max_temp",
        "nozzle_name",
        "nozzle_brand",
        "purchase_price",
        "location",
        "notes"
      ],
      resin_tank: [
        "resin_brand",
        "resin_type",
        "resin_color",
        "resin_hex",
        "resin_uv_wavelength_nm",
        "resin_uv_reactive",
        "resin_density",
        "resin_initial_volume_ml",
        "resin_purchase_date",
        "resin_production_date",
        "location",
        "notes"
      ]
    } as const;

    const allowedColumns = new Set<string>(allowedColumnsByType[asset.asset_type]);
    const filteredUpdates = Object.fromEntries(
      Object.entries(input).filter(([key]) =>
        allowedColumns.has(key)
      )
    );

    if (Object.keys(filteredUpdates).length === 0) {
      throw new BadRequestException("No valid fields were provided for this asset type.");
    }

    const { clause, values } = buildUpdateClause(filteredUpdates);

    await this.databaseService.query(
      `
        UPDATE asset_instances
        SET ${clause}
        WHERE company_id = $${values.length + 1}
          AND asset_id = $${values.length + 2}
      `,
      [...values, companyId, assetId]
    );

    const changedFields = Object.keys(filteredUpdates).join(", ");
    const assetName = this.buildAssetName(asset);
    await this.logAssetEvent(
      companyId,
      assetId,
      asset.asset_type,
      "edit",
      assetName,
      `Updated: ${changedFields}`
    );

    return this.getAssetById(companyId, assetId);
  }

  async updateAssetStock(
    companyId: string,
    assetId: string,
    input: UpdateAssetStockInput
  ) {
    await this.getAssetById(companyId, assetId);

    const { clause, values } = buildUpdateClause(input);

    await this.databaseService.query(
      `
        UPDATE asset_stock
        SET ${clause}
        WHERE company_id = $${values.length + 1}
          AND asset_id = $${values.length + 2}
      `,
      [...values, companyId, assetId]
    );

    const asset = await this.getAssetById(companyId, assetId);
    const assetName = this.buildAssetName(asset);

    // Determine event type
    const isAssignation = input.currently_used_in_piece_id !== undefined || input.installed_on_asset_id !== undefined;
    const eventType = isAssignation ? "assignation" : "edit";
    const changedFields = Object.keys(input).join(", ");
    const detail = isAssignation
      ? `Assigned: ${input.currently_used_in_piece_id ?? input.installed_on_asset_id ?? "unlinked"}`
      : `Stock updated: ${changedFields}`;

    await this.logAssetEvent(
      companyId,
      assetId,
      asset.asset_type,
      eventType,
      assetName,
      detail
    );

    return asset;
  }

  async deleteAsset(companyId: string, assetId: string) {
    await this.getAssetById(companyId, assetId);

    await this.databaseService.transaction(async (client) => {
      // 1. Remove spool assignments in order_piece_spools.
      //    spool_asset_id FK is ON DELETE RESTRICT, so this MUST run before
      //    deleting the asset_instances row.
      await client.query(`
        DELETE FROM order_piece_spools
        WHERE spool_asset_id = $1
          AND company_id = $2
      `, [assetId, companyId]);

      // 2. Nullify any mounted-nozzle reference on printers.
      //    current_nozzle_asset_id FK is ON DELETE SET NULL, but doing it
      //    explicitly inside the transaction is safer with RLS in play.
      await client.query(`
        UPDATE printer_stock
           SET current_nozzle_asset_id = NULL
         WHERE current_nozzle_asset_id = $1
      `, [assetId]);

      // 3. Delete asset stock (FK is ON DELETE CASCADE from asset_instances,
      //    but explicit delete prevents RLS from blocking the cascade).
      await client.query(`
        DELETE FROM asset_stock
        WHERE asset_id = $1
          AND company_id = $2
      `, [assetId, companyId]);

      // 4. Delete asset instance — all blocking FKs cleared above.
      await client.query(`
        DELETE FROM asset_instances
        WHERE asset_id = $1
          AND company_id = $2
      `, [assetId, companyId]);
    });
  }

  private async getFilamentReferenceById(
    filamentRefId: string,
    executor?: SqlExecutor
  ) {
    const result = await this.databaseService.query(
      `
        SELECT
          filament_ref_id,
          brand,
          material_type,
          color,
          diameter,
          melting_temp,
          max_print_speed_mm_s,
          hex,
          density,
          bed_temp,
          bed_temp_range,
          extruder_temp_range,
          finish,
          fill,
          pattern,
          multi_color_direction,
          translucent,
          glow,
          description,
          notes,
          source_type,
          company_id,
          created_by_company_id
        FROM filament_reference
        WHERE filament_ref_id = $1
      `,
      [filamentRefId],
      executor
    );

    if (!result.rowCount) {
      throw new NotFoundException("Filament reference not found.");
    }

    const row = result.rows[0];

    if (!row) {
      throw new NotFoundException("Filament reference not found.");
    }

    return row;
  }

  private assetSelectSql() {
    return `
      SELECT
        ai.asset_id,
        ai.company_id,
        ai.asset_type,
        ai.filament_ref_id,
        ai.parent_asset_id,
        ai.split_at,
        (SELECT COUNT(*) FROM asset_instances ch
          WHERE ch.parent_asset_id = ai.asset_id) AS child_spool_count,
        ai.initial_grams,
        ai.purchase_price,
        ai.purchase_date,
        ai.production_date,
        ai.nozzle_diameter_mm,
        ai.nozzle_material,
        ai.nozzle_max_temp,
        ai.nozzle_name,
        ai.nozzle_brand,
        ai.resin_brand,
        ai.resin_type,
        ai.resin_color,
        ai.resin_hex,
        ai.resin_uv_wavelength_nm,
        ai.resin_uv_reactive,
        ai.resin_density,
        ai.resin_initial_volume_ml,
        ai.resin_purchase_date,
        ai.resin_production_date,
        ai.location,
        ai.marker,
        ai.notes,
        ai.created_at,
        ast.status AS stock_status,
        ast.remaining_grams,
        ast.remaining_volume_ml,
        ast.reserved_grams,
        ast.reserved_volume_ml,
        CASE
          WHEN ast.remaining_grams IS NULL THEN NULL
          ELSE ast.remaining_grams - ast.reserved_grams
        END AS free_grams,
        CASE
          WHEN ast.remaining_volume_ml IS NULL THEN NULL
          ELSE ast.remaining_volume_ml - ast.reserved_volume_ml
        END AS free_volume_ml,
        -- ── Live "DB mirror" fields ──────────────────────────────────────
        -- These columns were never written by the scheduling/printing flow, so
        -- they always read NULL. Derive them on read from the authoritative
        -- reservation + schedule tables so the asset window reflects live state.
        -- A spool links to pieces via order_piece_spools; a nozzle via
        -- order_pieces.assigned_nozzle_asset_id. Bedded pieces carry their
        -- schedule on the parent print_beds row, so we fall back to it.
        COALESCE(
          (SELECT op.piece_id
             FROM order_piece_spools ops
             JOIN order_pieces op ON op.piece_id = ops.piece_id AND op.company_id = ops.company_id
            WHERE ops.spool_asset_id = ai.asset_id AND op.status = 'printing'
            ORDER BY op.print_started_at DESC NULLS LAST
            LIMIT 1),
          (SELECT op.piece_id
             FROM order_pieces op
            WHERE op.assigned_nozzle_asset_id = ai.asset_id
              AND op.company_id = ai.company_id
              AND op.bed_id IS NULL
              AND op.status = 'printing'
            ORDER BY op.print_started_at DESC NULLS LAST
            LIMIT 1)
        ) AS currently_used_in_piece_id,
        -- Human-readable resolution of the piece above (name + its order) so the
        -- UI can show a clickable name instead of a raw UUID.
        COALESCE(
          (SELECT op.piece_name
             FROM order_piece_spools ops
             JOIN order_pieces op ON op.piece_id = ops.piece_id AND op.company_id = ops.company_id
            WHERE ops.spool_asset_id = ai.asset_id AND op.status = 'printing'
            ORDER BY op.print_started_at DESC NULLS LAST
            LIMIT 1),
          (SELECT op.piece_name
             FROM order_pieces op
            WHERE op.assigned_nozzle_asset_id = ai.asset_id
              AND op.company_id = ai.company_id
              AND op.bed_id IS NULL
              AND op.status = 'printing'
            ORDER BY op.print_started_at DESC NULLS LAST
            LIMIT 1)
        ) AS currently_used_in_piece_name,
        COALESCE(
          (SELECT op.order_id
             FROM order_piece_spools ops
             JOIN order_pieces op ON op.piece_id = ops.piece_id AND op.company_id = ops.company_id
            WHERE ops.spool_asset_id = ai.asset_id AND op.status = 'printing'
            ORDER BY op.print_started_at DESC NULLS LAST
            LIMIT 1),
          (SELECT op.order_id
             FROM order_pieces op
            WHERE op.assigned_nozzle_asset_id = ai.asset_id
              AND op.company_id = ai.company_id
              AND op.bed_id IS NULL
              AND op.status = 'printing'
            ORDER BY op.print_started_at DESC NULLS LAST
            LIMIT 1)
        ) AS currently_used_in_order_id,
        COALESCE(
          (SELECT COALESCE(op.print_started_at, op.scheduled_start_at, pb.scheduled_start_at, pb.print_started_at)
             FROM order_piece_spools ops
             JOIN order_pieces op ON op.piece_id = ops.piece_id AND op.company_id = ops.company_id
             LEFT JOIN print_beds pb ON pb.bed_id = op.bed_id AND pb.company_id = op.company_id
            WHERE ops.spool_asset_id = ai.asset_id AND op.status = 'printing'
            ORDER BY COALESCE(op.print_started_at, op.scheduled_start_at) DESC NULLS LAST
            LIMIT 1),
          (SELECT COALESCE(op.print_started_at, op.scheduled_start_at, pb.scheduled_start_at, pb.print_started_at)
             FROM order_pieces op
             LEFT JOIN print_beds pb ON pb.bed_id = op.bed_id AND pb.company_id = op.company_id
            WHERE op.assigned_nozzle_asset_id = ai.asset_id
              AND op.company_id = ai.company_id
              AND op.status = 'printing'
            ORDER BY COALESCE(op.print_started_at, op.scheduled_start_at) DESC NULLS LAST
            LIMIT 1)
        ) AS in_use_since,
        COALESCE(
          ast.installed_on_asset_id,
          -- A nozzle is "installed on" the printer that currently mounts it.
          (SELECT ps.printer_id FROM printer_stock ps WHERE ps.current_nozzle_asset_id = ai.asset_id LIMIT 1)
        ) AS installed_on_asset_id,
        -- If this asset (nozzle) is mounted on a printer, resolve that printer's
        -- id + name so the UI can show a clickable name instead of a UUID.
        (SELECT ps2.printer_id FROM printer_stock ps2 WHERE ps2.current_nozzle_asset_id = ai.asset_id LIMIT 1) AS installed_on_printer_id,
        (SELECT COALESCE(
                  NULLIF(TRIM(COALESCE(p2.brand, pr2.brand, '') || ' ' || COALESCE(p2.model, pr2.model, '')), ''),
                  p2.serial_number,
                  'Printer')
           FROM printer_stock ps2
           JOIN printer_instances p2 ON p2.printer_id = ps2.printer_id
           LEFT JOIN printer_reference pr2 ON pr2.printer_ref_id = p2.printer_ref_id
          WHERE ps2.current_nozzle_asset_id = ai.asset_id LIMIT 1) AS installed_on_printer_name,
        COALESCE(
          (SELECT MAX(COALESCE(op.scheduled_end_at, pb.scheduled_end_at))
             FROM order_piece_spools ops
             JOIN order_pieces op ON op.piece_id = ops.piece_id AND op.company_id = ops.company_id
             LEFT JOIN print_beds pb ON pb.bed_id = op.bed_id AND pb.company_id = op.company_id
            WHERE ops.spool_asset_id = ai.asset_id AND op.status IN ('scheduled', 'printing')),
          (SELECT MAX(COALESCE(op.scheduled_end_at, pb.scheduled_end_at))
             FROM order_pieces op
             LEFT JOIN print_beds pb ON pb.bed_id = op.bed_id AND pb.company_id = op.company_id
            WHERE op.assigned_nozzle_asset_id = ai.asset_id
              AND op.company_id = ai.company_id
              AND op.status IN ('scheduled', 'printing'))
        ) AS next_free_at,
        ast.last_updated_at AS stock_last_updated_at,
        fr.brand AS filament_brand,
        fr.material_type AS filament_material_type,
        fr.color AS filament_color,
        fr.diameter AS filament_diameter,
        fr.source_type AS filament_source_type,
        fr.melting_temp AS filament_melting_temp,
        fr.max_print_speed_mm_s AS filament_max_print_speed_mm_s,
        fr.hex AS filament_hex,
        fr.density AS filament_density,
        fr.bed_temp AS filament_bed_temp,
        fr.bed_temp_range AS filament_bed_temp_range,
        fr.extruder_temp_range AS filament_extruder_temp_range,
        fr.finish AS filament_finish,
        fr.fill AS filament_fill,
        fr.pattern AS filament_pattern,
        fr.multi_color_direction AS filament_multi_color_direction,
        fr.translucent AS filament_translucent,
        fr.glow AS filament_glow,
        fr.description AS filament_description,
        fr.notes AS filament_notes
      FROM asset_instances ai
      INNER JOIN asset_stock ast
        ON ast.asset_id = ai.asset_id
      LEFT JOIN filament_reference fr
        ON fr.filament_ref_id = ai.filament_ref_id
    `;
  }

  // ── History ─────────────────────────────────────────────────────────────────

  async listAssetHistory(companyId: string, query: ListAssetHistoryQuery) {
    const values: unknown[] = [companyId, query.days];
    const filters = ["company_id = $1", "created_at >= now() - ($2 || ' days')::interval"];

    if (query.event_type) {
      values.push(query.event_type);
      filters.push(`event_type = $${values.length}`);
    }

    if (query.asset_type) {
      values.push(query.asset_type);
      filters.push(`asset_type = $${values.length}`);
    }

    const result = await this.databaseService.query(
      `
        SELECT
          history_id,
          company_id,
          asset_id,
          asset_type,
          event_type,
          asset_name,
          details,
          performed_by,
          created_at
        FROM asset_history
        WHERE ${filters.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT 200
      `,
      values
    );

    return result.rows;
  }

  async logAssetEvent(
    companyId: string,
    assetId: string,
    assetType: string,
    eventType: "addition" | "edit" | "assignation",
    assetName: string,
    details?: string,
    executor?: SqlExecutor
  ) {
    await this.databaseService.query(
      `
        INSERT INTO asset_history (
          company_id, asset_id, asset_type, event_type, asset_name, details
        )
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [companyId, assetId, assetType, eventType, assetName, details ?? null],
      executor
    );
  }

  private buildAssetName(asset: AssetRow): string {
    if (asset.asset_type === "filament_spool") {
      return [asset.filament_brand, asset.filament_material_type, asset.filament_color]
        .filter(Boolean).join(" ") || "Filament Spool";
    }
    if (asset.asset_type === "nozzle") {
      // A user-given name wins; otherwise derive "<brand> <material> <dia>mm Nozzle".
      if (asset.nozzle_name) return asset.nozzle_name;
      return [asset.nozzle_brand, asset.nozzle_material, asset.nozzle_diameter_mm ? `${asset.nozzle_diameter_mm}mm` : null]
        .filter(Boolean).join(" ") + " Nozzle" || "Nozzle";
    }
    if (asset.asset_type === "resin_tank") {
      return [asset.resin_brand, asset.resin_type, asset.resin_color]
        .filter(Boolean).join(" ") + " Tank" || "Resin Tank";
    }
    return "Asset";
  }
}
