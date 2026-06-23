import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { z } from "zod";
import { revertPrinterAssignmentsTx } from "../common/cascade";
import { buildUpdateClause } from "../common/sql";
import { DatabaseService, type SqlExecutor } from "../database/database.service";
import {
  addCompatibleNozzleSchema,
  createPrinterReferenceSchema,
  createPrinterSchema,
  listPrinterReferencesQuerySchema,
  listPrintersQuerySchema,
  updatePrinterSchema,
  updatePrinterStockSchema
} from "./printers.schemas";

type PrinterReferenceInput = z.infer<typeof createPrinterReferenceSchema>;
type CreatePrinterInput = z.infer<typeof createPrinterSchema>;
type ListPrinterReferencesQuery = z.infer<typeof listPrinterReferencesQuerySchema>;
type ListPrintersQuery = z.infer<typeof listPrintersQuerySchema>;
type UpdatePrinterInput = z.infer<typeof updatePrinterSchema>;
type UpdatePrinterStockInput = z.infer<typeof updatePrinterStockSchema>;
type AddCompatibleNozzleInput = z.infer<typeof addCompatibleNozzleSchema>;

type PrinterReferenceRow = {
  printer_ref_id: string;
  brand: string;
  model: string;
  print_technology: string;
  build_volume_x_mm: string;
  build_volume_y_mm: string;
  build_volume_z_mm: string;
  max_hotend_temp: number | null;
  max_bed_temp: number | null;
  extruder_type: string | null;
  nozzle_count: number;
  compatible_nozzle_diameters: number[] | null;
  compatible_materials: string[] | null;
  max_filament_diameter: string | null;
  is_multicolor: boolean;
  ams_unit_count: number | null;
  max_color_count: number | null;
  uv_wavelength_nm: number | null;
  build_platform_type: string | null;
  has_camera: boolean;
  has_enclosure: boolean;
  has_filament_sensor: boolean;
  network_capability: string | null;
  description: string | null;
  notes: string | null;
  source_type: string;
  created_by_company_id: string | null;
};

@Injectable()
export class PrintersService {
  constructor(private readonly databaseService: DatabaseService) {}

  async listPrinterReferences(query: ListPrinterReferencesQuery) {
    const values: unknown[] = [];
    const filters: string[] = [];

    if (query.brand) {
      values.push(query.brand);
      filters.push(`brand = $${values.length}`);
    }

    if (query.technology) {
      values.push(query.technology);
      filters.push(`print_technology = $${values.length}`);
    }

    if (query.search) {
      values.push(`%${query.search}%`);
      filters.push(`(brand ILIKE $${values.length} OR model ILIKE $${values.length})`);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

    const result = await this.databaseService.query(
      `
        SELECT
          printer_ref_id,
          brand,
          model,
          print_technology,
          build_volume_x_mm,
          build_volume_y_mm,
          build_volume_z_mm,
          max_hotend_temp,
          max_bed_temp,
          extruder_type,
          nozzle_count,
          compatible_nozzle_diameters,
          compatible_materials,
          max_filament_diameter,
          is_multicolor,
          ams_unit_count,
          max_color_count,
          uv_wavelength_nm,
          build_platform_type,
          has_camera,
          has_enclosure,
          has_filament_sensor,
          network_capability,
          description,
          notes,
          source_type,
          created_by_company_id
        FROM printer_reference
        ${whereClause}
        ORDER BY brand, model
      `,
      values
    );

    return result.rows;
  }

  async createPrinterReference(
    companyId: string,
    input: PrinterReferenceInput,
    executor?: SqlExecutor
  ) {
    const existing = await this.databaseService.query<{ printer_ref_id: string }>(
      `
        SELECT printer_ref_id
        FROM printer_reference
        WHERE lower(brand) = lower($1)
          AND lower(model) = lower($2)
        LIMIT 1
      `,
      [input.brand, input.model],
      executor
    );

    const existingRow = existing.rows[0];

    if (existingRow) {
      return this.getPrinterReferenceById(existingRow.printer_ref_id, executor);
    }

    const created = await this.databaseService.query<{ printer_ref_id: string }>(
      `
        INSERT INTO printer_reference (
          company_id,
          created_by_company_id,
          source_type,
          brand,
          model,
          print_technology,
          build_volume_x_mm,
          build_volume_y_mm,
          build_volume_z_mm,
          max_hotend_temp,
          max_bed_temp,
          extruder_type,
          nozzle_count,
          compatible_nozzle_diameters,
          compatible_materials,
          max_filament_diameter,
          is_multicolor,
          ams_unit_count,
          max_color_count,
          uv_wavelength_nm,
          build_platform_type,
          has_camera,
          has_enclosure,
          has_filament_sensor,
          network_capability,
          description,
          notes
        )
        VALUES (
          NULL,
          $1,
          'global_custom',
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
          $21,
          $22,
          $23,
          $24,
          $25
        )
        RETURNING printer_ref_id
      `,
      [
        companyId,
        input.brand,
        input.model,
        input.print_technology,
        input.build_volume_x_mm,
        input.build_volume_y_mm,
        input.build_volume_z_mm,
        input.max_hotend_temp ?? null,
        input.max_bed_temp ?? null,
        input.extruder_type ?? null,
        input.nozzle_count ?? 1,
        input.compatible_nozzle_diameters ?? null,
        input.compatible_materials ?? null,
        input.max_filament_diameter ?? null,
        input.is_multicolor ?? false,
        input.ams_unit_count ?? null,
        input.max_color_count ?? null,
        input.uv_wavelength_nm ?? null,
        input.build_platform_type ?? null,
        input.has_camera ?? false,
        input.has_enclosure ?? false,
        input.has_filament_sensor ?? false,
        input.network_capability ?? null,
        input.description ?? null,
        input.notes ?? null
      ],
      executor
    );

    const createdRow = created.rows[0];

    if (!createdRow) {
      throw new BadRequestException("Printer reference insert failed.");
    }

    return this.getPrinterReferenceById(createdRow.printer_ref_id, executor);
  }

  async listPrinters(companyId: string, query: ListPrintersQuery) {
    const values: unknown[] = [companyId];
    const filters = ["pi.company_id = $1"];

    if (query.is_in_use !== undefined) {
      values.push(query.is_in_use);
      filters.push(`ps.is_in_use = $${values.length}`);
    }

    if (query.is_under_maintenance !== undefined) {
      values.push(query.is_under_maintenance);
      filters.push(`ps.is_under_maintenance = $${values.length}`);
    }

    if (query.is_offline !== undefined) {
      values.push(query.is_offline);
      filters.push(`ps.is_offline = $${values.length}`);
    }

    if (query.search) {
      values.push(`%${query.search}%`);
      filters.push(`
        (
          COALESCE(pr.brand, pi.brand) ILIKE $${values.length}
          OR COALESCE(pr.model, pi.model) ILIKE $${values.length}
          OR pi.serial_number ILIKE $${values.length}
          OR pi.location ILIKE $${values.length}
          OR pi.printer_id::text ILIKE $${values.length}
          OR upper(substr(replace(pi.printer_id::text, '-', ''), 1, 8)) ILIKE replace(upper($${values.length}), '-', '')
        )
      `);
    }

    const result = await this.databaseService.query(
      `
        ${this.printerSelectSql()}
        WHERE ${filters.join(" AND ")}
        ORDER BY pi.created_at DESC
      `,
      values
    );

    return result.rows;
  }

  async getPrinterById(
    companyId: string,
    printerId: string,
    executor?: SqlExecutor
  ): Promise<Record<string, unknown>> {
    const result = await this.databaseService.query(
      `
        ${this.printerSelectSql()}
        WHERE pi.company_id = $1
          AND pi.printer_id = $2
      `,
      [companyId, printerId],
      executor
    );

    if (!result.rowCount) {
      throw new NotFoundException("Printer not found.");
    }

    const row = result.rows[0];

    if (!row) {
      throw new NotFoundException("Printer not found.");
    }

    return row;
  }

  async createPrinter(companyId: string, input: CreatePrinterInput) {
    return this.databaseService.transaction(async (client) => {
      const printerReference = input.printer_ref_id
        ? await this.getPrinterReferenceById(input.printer_ref_id, client)
        : await this.createPrinterReference(companyId, input.custom_reference!, client);

      const createdPrinter = await this.databaseService.query<{ printer_id: string }>(
        `
          INSERT INTO printer_instances (
            company_id,
            printer_ref_id,
            brand,
            model,
            serial_number,
            purchase_date,
            power_watts,
            print_technology,
            build_volume_x_mm,
            build_volume_y_mm,
            build_volume_z_mm,
            max_hotend_temp,
            max_bed_temp,
            extruder_type,
            nozzle_count,
            compatible_nozzle_diameters,
            is_multicolor,
            ams_unit_count,
            max_color_count,
            compatible_materials,
            max_filament_diameter,
            uv_wavelength_nm,
            build_platform_type,
            has_camera,
            has_enclosure,
            has_filament_sensor,
            network_capability,
            location,
            notes
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
            $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
            $25, $26, $27, $28, $29
          )
          RETURNING printer_id
        `,
        [
          companyId,
          printerReference.printer_ref_id,
          printerReference.brand,
          printerReference.model,
          input.serial_number ?? null,
          input.purchase_date ?? null,
          input.power_watts ?? null,
          printerReference.print_technology,
          printerReference.build_volume_x_mm,
          printerReference.build_volume_y_mm,
          printerReference.build_volume_z_mm,
          printerReference.max_hotend_temp,
          printerReference.max_bed_temp,
          printerReference.extruder_type,
          printerReference.nozzle_count,
          printerReference.compatible_nozzle_diameters,
          printerReference.is_multicolor,
          printerReference.ams_unit_count,
          printerReference.max_color_count,
          printerReference.compatible_materials,
          printerReference.max_filament_diameter,
          printerReference.uv_wavelength_nm,
          printerReference.build_platform_type,
          printerReference.has_camera,
          printerReference.has_enclosure,
          printerReference.has_filament_sensor,
          printerReference.network_capability,
          input.location ?? null,
          input.notes ?? null
        ],
        client
      );

      const createdPrinterRow = createdPrinter.rows[0];

      if (!createdPrinterRow) {
        throw new BadRequestException("Printer insert failed.");
      }

      await this.databaseService.query(
        `
          INSERT INTO printer_stock (
            printer_id,
            company_id,
            is_in_use,
            is_under_maintenance,
            is_offline,
            currently_printing_order_id,
            currently_printing_piece_id,
            print_started_at,
            estimated_print_end_at,
            next_free_at,
            last_available_at,
            current_nozzle_asset_id,
            maintenance_started_at,
            maintenance_reason,
            total_print_hours,
            last_maintenance_at
          )
          VALUES (
            $1, $2, FALSE, FALSE, FALSE,
            NULL, NULL, NULL, NULL, NULL, NULL,
            NULL, NULL, NULL, $3, NULL
          )
        `,
        [createdPrinterRow.printer_id, companyId, input.total_print_hours ?? 0],
        client
      );

      return this.getPrinterById(companyId, createdPrinterRow.printer_id, client);
    });
  }

  async updatePrinter(
    companyId: string,
    printerId: string,
    input: UpdatePrinterInput
  ) {
    await this.getPrinterById(companyId, printerId);

    const instanceUpdates: Record<string, unknown> = {
      serial_number: input.serial_number,
      purchase_date: input.purchase_date,
      power_watts: input.power_watts,
      location: input.location,
      marker: input.marker,
      notes: input.notes
    };

    if (input.printer_ref_id || input.custom_reference) {
      const printerReference = input.printer_ref_id
        ? await this.getPrinterReferenceById(input.printer_ref_id)
        : await this.createPrinterReference(companyId, input.custom_reference!);

      Object.assign(instanceUpdates, {
        printer_ref_id: printerReference.printer_ref_id,
        brand: printerReference.brand,
        model: printerReference.model,
        print_technology: printerReference.print_technology,
        build_volume_x_mm: printerReference.build_volume_x_mm,
        build_volume_y_mm: printerReference.build_volume_y_mm,
        build_volume_z_mm: printerReference.build_volume_z_mm,
        max_hotend_temp: printerReference.max_hotend_temp,
        max_bed_temp: printerReference.max_bed_temp,
        extruder_type: printerReference.extruder_type,
        nozzle_count: printerReference.nozzle_count,
        compatible_nozzle_diameters: printerReference.compatible_nozzle_diameters,
        is_multicolor: printerReference.is_multicolor,
        ams_unit_count: printerReference.ams_unit_count,
        max_color_count: printerReference.max_color_count,
        compatible_materials: printerReference.compatible_materials,
        max_filament_diameter: printerReference.max_filament_diameter,
        uv_wavelength_nm: printerReference.uv_wavelength_nm,
        build_platform_type: printerReference.build_platform_type,
        has_camera: printerReference.has_camera,
        has_enclosure: printerReference.has_enclosure,
        has_filament_sensor: printerReference.has_filament_sensor,
        network_capability: printerReference.network_capability
      });
    }

    const { clause, values } = buildUpdateClause(instanceUpdates);

    await this.databaseService.query(
      `
        UPDATE printer_instances
        SET ${clause}
        WHERE company_id = $${values.length + 1}
          AND printer_id = $${values.length + 2}
      `,
      [...values, companyId, printerId]
    );

    return this.getPrinterById(companyId, printerId);
  }

  async updatePrinterStock(
    companyId: string,
    printerId: string,
    input: UpdatePrinterStockInput
  ) {
    await this.getPrinterById(companyId, printerId);

    // Normalize the incoming state before it ever reaches the DB constraints.
    const updates: Record<string, unknown> = { ...input };

    if (updates.is_under_maintenance === true) {
      // Maintenance always forces the printer offline.
      updates.is_offline = true;
      // chk_maintenance_started requires a start timestamp whenever maintenance
      // is on. The edit form leaves this blank, which previously produced a 500;
      // default it to "now" when the client didn't supply one.
      if (
        updates.maintenance_started_at === undefined ||
        updates.maintenance_started_at === null
      ) {
        updates.maintenance_started_at = new Date().toISOString();
      }
    } else if (updates.is_under_maintenance === false) {
      // chk_maintenance_started requires these to be null when maintenance is off.
      updates.maintenance_started_at = null;
      updates.maintenance_reason = null;
    }

    const willBeOffline =
      updates.is_offline === true || updates.is_under_maintenance === true;

    return this.databaseService.transaction(async (client) => {
      const { clause, values } = buildUpdateClause(updates);

      if (clause) {
        await this.databaseService.query(
          `
            UPDATE printer_stock
            SET ${clause}
            WHERE company_id = $${values.length + 1}
              AND printer_id = $${values.length + 2}
          `,
          [...values, companyId, printerId],
          client
        );
      }

      // Taking a printer offline (directly or via maintenance) sends every
      // below-printing assignment back to pending and frees its reservations.
      if (willBeOffline) {
        await revertPrinterAssignmentsTx(client, companyId, printerId);
      }

      return this.getPrinterById(companyId, printerId, client);
    });
  }

  async listNozzleOptions(companyId: string) {
    const result = await this.databaseService.query(
      `
        SELECT
          ai.asset_id,
          ai.nozzle_diameter_mm,
          ai.nozzle_material,
          ai.nozzle_max_temp,
          ai.notes,
          ast.status,
          ast.installed_on_asset_id
        FROM asset_instances ai
        INNER JOIN asset_stock ast
          ON ast.asset_id = ai.asset_id
        WHERE ai.company_id = $1
          AND ai.asset_type = 'nozzle'
        ORDER BY ai.created_at DESC
      `,
      [companyId]
    );

    return result.rows;
  }

  async listNozzleCompatibility(companyId: string, printerId: string) {
    await this.getPrinterById(companyId, printerId);

    const result = await this.databaseService.query(
      `
        SELECT
          pnc.printer_id,
          pnc.nozzle_asset_id,
          pnc.confirmed_at,
          pnc.notes,
          ai.nozzle_diameter_mm,
          ai.nozzle_material,
          ai.nozzle_max_temp,
          ast.status AS stock_status,
          ast.installed_on_asset_id
        FROM printer_nozzle_compatibility pnc
        INNER JOIN asset_instances ai
          ON ai.asset_id = pnc.nozzle_asset_id
        INNER JOIN asset_stock ast
          ON ast.asset_id = ai.asset_id
        WHERE pnc.company_id = $1
          AND pnc.printer_id = $2
        ORDER BY pnc.confirmed_at DESC
      `,
      [companyId, printerId]
    );

    return result.rows;
  }

  async addNozzleCompatibility(
    companyId: string,
    printerId: string,
    input: AddCompatibleNozzleInput
  ) {
    await this.getPrinterById(companyId, printerId);

    const nozzle = await this.databaseService.query<{ asset_type: string }>(
      `
        SELECT asset_type
        FROM asset_instances
        WHERE company_id = $1
          AND asset_id = $2
      `,
      [companyId, input.nozzle_asset_id]
    );

    if (!nozzle.rowCount) {
      throw new NotFoundException("Nozzle asset not found.");
    }

    const nozzleRow = nozzle.rows[0];

    if (!nozzleRow) {
      throw new NotFoundException("Nozzle asset not found.");
    }

    if (nozzleRow.asset_type !== "nozzle") {
      throw new BadRequestException("Only nozzle assets can be added to printer compatibility.");
    }

    await this.databaseService.query(
      `
        INSERT INTO printer_nozzle_compatibility (
          printer_id,
          nozzle_asset_id,
          company_id,
          notes
        )
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (printer_id, nozzle_asset_id)
        DO UPDATE
        SET
          confirmed_at = now(),
          notes = EXCLUDED.notes,
          company_id = EXCLUDED.company_id
      `,
      [printerId, input.nozzle_asset_id, companyId, input.notes ?? null]
    );

    return this.listNozzleCompatibility(companyId, printerId);
  }

  async removeNozzleCompatibility(
    companyId: string,
    printerId: string,
    nozzleAssetId: string
  ) {
    await this.databaseService.query(
      `
        DELETE FROM printer_nozzle_compatibility
        WHERE company_id = $1
          AND printer_id = $2
          AND nozzle_asset_id = $3
      `,
      [companyId, printerId, nozzleAssetId]
    );

    return this.listNozzleCompatibility(companyId, printerId);
  }

  private async getPrinterReferenceById(
    printerRefId: string,
    executor?: SqlExecutor
  ): Promise<PrinterReferenceRow> {
    const result = await this.databaseService.query<PrinterReferenceRow>(
      `
        SELECT
          printer_ref_id,
          brand,
          model,
          print_technology,
          build_volume_x_mm,
          build_volume_y_mm,
          build_volume_z_mm,
          max_hotend_temp,
          max_bed_temp,
          extruder_type,
          nozzle_count,
          compatible_nozzle_diameters,
          compatible_materials,
          max_filament_diameter,
          is_multicolor,
          ams_unit_count,
          max_color_count,
          uv_wavelength_nm,
          build_platform_type,
          has_camera,
          has_enclosure,
          has_filament_sensor,
          network_capability,
          description,
          notes,
          source_type,
          created_by_company_id
        FROM printer_reference
        WHERE printer_ref_id = $1
      `,
      [printerRefId],
      executor
    );

    if (!result.rowCount) {
      throw new NotFoundException("Printer reference not found.");
    }

    const row = result.rows[0];

    if (!row) {
      throw new NotFoundException("Printer reference not found.");
    }

    return row;
  }

  private printerSelectSql() {
    return `
      SELECT
        pi.printer_id,
        pi.company_id,
        pi.printer_ref_id,
        COALESCE(pr.brand, pi.brand) AS brand,
        COALESCE(pr.model, pi.model) AS model,
        pi.serial_number,
        pi.purchase_date,
        pi.power_watts,
        COALESCE(pr.print_technology, pi.print_technology) AS print_technology,
        COALESCE(pr.build_volume_x_mm, pi.build_volume_x_mm) AS build_volume_x_mm,
        COALESCE(pr.build_volume_y_mm, pi.build_volume_y_mm) AS build_volume_y_mm,
        COALESCE(pr.build_volume_z_mm, pi.build_volume_z_mm) AS build_volume_z_mm,
        COALESCE(pr.max_hotend_temp, pi.max_hotend_temp) AS max_hotend_temp,
        COALESCE(pr.max_bed_temp, pi.max_bed_temp) AS max_bed_temp,
        COALESCE(pr.extruder_type, pi.extruder_type) AS extruder_type,
        COALESCE(pr.nozzle_count, pi.nozzle_count) AS nozzle_count,
        COALESCE(pr.compatible_nozzle_diameters, pi.compatible_nozzle_diameters) AS compatible_nozzle_diameters,
        COALESCE(pr.is_multicolor, pi.is_multicolor) AS is_multicolor,
        COALESCE(pr.ams_unit_count, pi.ams_unit_count) AS ams_unit_count,
        COALESCE(pr.max_color_count, pi.max_color_count) AS max_color_count,
        COALESCE(pr.compatible_materials, pi.compatible_materials) AS compatible_materials,
        COALESCE(pr.max_filament_diameter, pi.max_filament_diameter) AS max_filament_diameter,
        COALESCE(pr.uv_wavelength_nm, pi.uv_wavelength_nm) AS uv_wavelength_nm,
        COALESCE(pr.build_platform_type, pi.build_platform_type) AS build_platform_type,
        COALESCE(pr.has_camera, pi.has_camera) AS has_camera,
        COALESCE(pr.has_enclosure, pi.has_enclosure) AS has_enclosure,
        COALESCE(pr.has_filament_sensor, pi.has_filament_sensor) AS has_filament_sensor,
        COALESCE(pr.network_capability, pi.network_capability) AS network_capability,
        pi.location,
        pi.marker,
        pi.notes,
        pi.created_at,
        -- ── Live "DB mirror" / execution fields ──────────────────────────
        -- printer_stock's execution columns were never written by the
        -- scheduling/printing flow, so they always read NULL/0. Derive them on
        -- read from the authoritative schedule tables (standalone pieces carry
        -- their own schedule; bedded prints live on print_beds) so the printer
        -- window reflects live state.
        (EXISTS (
           SELECT 1 FROM order_pieces op
            WHERE op.assigned_printer_id = pi.printer_id AND op.company_id = pi.company_id
              AND op.bed_id IS NULL AND op.status = 'printing')
         OR EXISTS (
           SELECT 1 FROM print_beds pb
            WHERE pb.assigned_printer_id = pi.printer_id AND pb.company_id = pi.company_id
              AND pb.status = 'printing')
        ) AS is_in_use,
        ps.is_under_maintenance,
        ps.is_offline,
        (SELECT op.order_id FROM order_pieces op
          WHERE op.assigned_printer_id = pi.printer_id AND op.company_id = pi.company_id
            AND op.bed_id IS NULL AND op.status = 'printing'
          ORDER BY op.print_started_at DESC NULLS LAST LIMIT 1) AS currently_printing_order_id,
        (SELECT o.order_number FROM order_pieces op
           JOIN orders o ON o.order_id = op.order_id AND o.company_id = op.company_id
          WHERE op.assigned_printer_id = pi.printer_id AND op.company_id = pi.company_id
            AND op.bed_id IS NULL AND op.status = 'printing'
          ORDER BY op.print_started_at DESC NULLS LAST LIMIT 1) AS currently_printing_order_number,
        (SELECT op.piece_id FROM order_pieces op
          WHERE op.assigned_printer_id = pi.printer_id AND op.company_id = pi.company_id
            AND op.bed_id IS NULL AND op.status = 'printing'
          ORDER BY op.print_started_at DESC NULLS LAST LIMIT 1) AS currently_printing_piece_id,
        (SELECT op.piece_name FROM order_pieces op
          WHERE op.assigned_printer_id = pi.printer_id AND op.company_id = pi.company_id
            AND op.bed_id IS NULL AND op.status = 'printing'
          ORDER BY op.print_started_at DESC NULLS LAST LIMIT 1) AS currently_printing_piece_name,
        COALESCE(
          (SELECT MIN(s) FROM (
             SELECT op.print_started_at AS s FROM order_pieces op
               WHERE op.assigned_printer_id = pi.printer_id AND op.company_id = pi.company_id
                 AND op.bed_id IS NULL AND op.status = 'printing'
             UNION ALL
             SELECT pb.print_started_at FROM print_beds pb
               WHERE pb.assigned_printer_id = pi.printer_id AND pb.company_id = pi.company_id
                 AND pb.status = 'printing'
           ) u),
          ps.print_started_at
        ) AS print_started_at,
        COALESCE(
          (SELECT MAX(e) FROM (
             SELECT op.scheduled_end_at AS e FROM order_pieces op
               WHERE op.assigned_printer_id = pi.printer_id AND op.company_id = pi.company_id
                 AND op.bed_id IS NULL AND op.status = 'printing'
             UNION ALL
             SELECT pb.scheduled_end_at FROM print_beds pb
               WHERE pb.assigned_printer_id = pi.printer_id AND pb.company_id = pi.company_id
                 AND pb.status = 'printing'
           ) u),
          ps.estimated_print_end_at
        ) AS estimated_print_end_at,
        COALESCE(
          (SELECT MAX(e) FROM (
             SELECT op.scheduled_end_at AS e FROM order_pieces op
               WHERE op.assigned_printer_id = pi.printer_id AND op.company_id = pi.company_id
                 AND op.bed_id IS NULL AND op.status IN ('scheduled', 'printing')
             UNION ALL
             SELECT pb.scheduled_end_at FROM print_beds pb
               WHERE pb.assigned_printer_id = pi.printer_id AND pb.company_id = pi.company_id
                 AND pb.status IN ('scheduled', 'printing')
           ) u),
          ps.next_free_at
        ) AS next_free_at,
        COALESCE(
          (SELECT MAX(e) FROM (
             SELECT op.print_completed_at AS e FROM order_pieces op
               WHERE op.assigned_printer_id = pi.printer_id AND op.company_id = pi.company_id
                 AND op.bed_id IS NULL AND op.status IN ('done', 'failed')
             UNION ALL
             SELECT pb.print_completed_at FROM print_beds pb
               WHERE pb.assigned_printer_id = pi.printer_id AND pb.company_id = pi.company_id
                 AND pb.status IN ('done', 'failed')
           ) u),
          ps.last_available_at
        ) AS last_available_at,
        ps.current_nozzle_asset_id,
        (SELECT COALESCE(
                  NULLIF(TRIM(COALESCE(noz.nozzle_diameter_mm::text || 'mm', '') || ' ' || COALESCE(noz.nozzle_material, '')), ''),
                  'Nozzle')
           FROM asset_instances noz
          WHERE noz.asset_id = ps.current_nozzle_asset_id LIMIT 1) AS current_nozzle_label,
        ps.maintenance_started_at,
        ps.maintenance_reason,
        -- Total worked hours = an operator-owned BASE (initialized at creation,
        -- editable via the stock PATCH) PLUS auto-accumulated completed-print
        -- time. The base is exposed separately so the editor can show/edit it.
        ps.total_print_hours AS total_print_hours_base,
        (COALESCE(ps.total_print_hours, 0) + COALESCE(
          (SELECT ROUND(SUM(mins)::numeric / 60.0, 2) FROM (
             SELECT COALESCE(op.actual_print_time_minutes, op.slicer_print_time_minutes, 0) AS mins
               FROM order_pieces op
              WHERE op.assigned_printer_id = pi.printer_id AND op.company_id = pi.company_id
                AND op.bed_id IS NULL AND op.status = 'done'
             UNION ALL
             SELECT COALESCE(pb.actual_print_time_minutes, pb.slicer_print_time_minutes, 0) AS mins
               FROM print_beds pb
              WHERE pb.assigned_printer_id = pi.printer_id AND pb.company_id = pi.company_id
                AND pb.status = 'done'
           ) u),
          0
        )) AS total_print_hours,
        ps.last_maintenance_at,
        ps.last_updated_at AS stock_last_updated_at
      FROM printer_instances pi
      INNER JOIN printer_stock ps
        ON ps.printer_id = pi.printer_id
      LEFT JOIN printer_reference pr
        ON pr.printer_ref_id = pi.printer_ref_id
    `;
  }

  async deletePrinter(companyId: string, printerId: string) {
    await this.getPrinterById(companyId, printerId);

    await this.databaseService.transaction(async (client) => {
      // 1. Delete printer nozzle compatibility
      await client.query(`
        DELETE FROM printer_nozzle_compatibility
        WHERE printer_id = $1
          AND company_id = $2
      `, [printerId, companyId]);

      // 2. Delete printer stock
      await client.query(`
        DELETE FROM printer_stock
        WHERE printer_id = $1
          AND company_id = $2
      `, [printerId, companyId]);

      // 3. Delete printer instance
      await client.query(`
        DELETE FROM printer_instances
        WHERE printer_id = $1
          AND company_id = $2
      `, [printerId, companyId]);
    });
  }
}
