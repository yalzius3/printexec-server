import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService, type SqlExecutor } from "../database/database.service";
import { buildUpdateClause } from "../common/sql";
import {
  createFilamentReferenceSchema,
  createNozzleSchema,
  createResinTankSchema,
  createSpoolSchema,
  listAssetsQuerySchema,
  listAssetHistoryQuerySchema,
  listFilamentReferencesQuerySchema,
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

type AssetRow = {
  asset_id: string;
  company_id: string;
  asset_type: "filament_spool" | "nozzle" | "resin_tank";
  filament_ref_id: string | null;
  initial_grams: string | null;
  purchase_date: string | null;
  production_date: string | null;
  nozzle_diameter_mm: string | null;
  nozzle_material: string | null;
  nozzle_max_temp: number | null;
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
  constructor(private readonly databaseService: DatabaseService) {}

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
      `SELECT ai.asset_id, ai.filament_ref_id, ai.initial_grams, ai.location, ai.marker,
              COALESCE(ast.remaining_grams, ai.initial_grams) AS remaining_grams,
              COALESCE(ast.reserved_grams, 0)                 AS reserved_grams,
              COALESCE(ast.status, 'available')               AS status,
              fr.brand, fr.material_type, fr.color
         FROM asset_instances ai
         LEFT JOIN asset_stock ast ON ast.asset_id = ai.asset_id
         LEFT JOIN filament_reference fr ON fr.filament_ref_id = ai.filament_ref_id
        WHERE ai.company_id = $1 AND ai.asset_type = 'filament_spool'
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

  async createSpool(companyId: string, input: CreateSpoolInput) {
    return this.databaseService.transaction(async (client) => {
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

      const createdAsset = await this.databaseService.query<{ asset_id: string }>(
        `
          INSERT INTO asset_instances (
            company_id,
            asset_type,
            filament_ref_id,
            initial_grams,
            purchase_date,
            production_date,
            location,
            marker,
            notes
          )
          VALUES ($1, 'filament_spool', $2, $3, $4, $5, $6, $7, $8)
          RETURNING asset_id
        `,
        [
          companyId,
          filamentRefId,
          input.initial_grams,
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
        "New spool added to inventory",
        client
      );

      return this.getAssetById(companyId, createdAssetRow.asset_id, client);
    });
  }

  async createNozzle(companyId: string, input: CreateNozzleInput) {
    return this.databaseService.transaction(async (client) => {
      const createdAsset = await this.databaseService.query<{ asset_id: string }>(
        `
          INSERT INTO asset_instances (
            company_id,
            asset_type,
            nozzle_diameter_mm,
            nozzle_material,
            nozzle_max_temp,
            location,
            notes
          )
          VALUES ($1, 'nozzle', $2, $3, $4, $5, $6)
          RETURNING asset_id
        `,
        [
          companyId,
          input.nozzle_diameter_mm,
          input.nozzle_material,
          input.nozzle_max_temp ?? null,
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
        `${input.nozzle_material} ${input.nozzle_diameter_mm}mm Nozzle`,
        "New nozzle added to inventory",
        client
      );

      return this.getAssetById(companyId, createdAssetRow.asset_id, client);
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
        ai.initial_grams,
        ai.purchase_date,
        ai.production_date,
        ai.nozzle_diameter_mm,
        ai.nozzle_material,
        ai.nozzle_max_temp,
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
      return [asset.nozzle_material, asset.nozzle_diameter_mm ? `${asset.nozzle_diameter_mm}mm` : null]
        .filter(Boolean).join(" ") + " Nozzle" || "Nozzle";
    }
    if (asset.asset_type === "resin_tank") {
      return [asset.resin_brand, asset.resin_type, asset.resin_color]
        .filter(Boolean).join(" ") + " Tank" || "Resin Tank";
    }
    return "Asset";
  }
}
