import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { z } from "zod";
import { revertPrinterAssignmentsTx } from "../common/cascade";
import { buildUpdateClause } from "../common/sql";
import { DatabaseService, type SqlExecutor } from "../database/database.service";
import { isResinTech } from "../jobs/matching";
import { LicensingService } from "../licensing/licensing.service";
import {
  addCompatibleNozzleSchema,
  bulkNozzleCompatibilitySchema,
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
type BulkNozzleCompatibilityInput = z.infer<typeof bulkNozzleCompatibilitySchema>;

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
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly licensingService: LicensingService
  ) {}

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
      // License cap gate. The transaction-scoped advisory lock serialises
      // concurrent adds for one company so two requests can't both pass the
      // count check while under the cap by one.
      await this.databaseService.query(
        "SELECT pg_advisory_xact_lock(hashtext('printer_cap:' || $1))",
        [companyId],
        client
      );

      const printerReference = input.printer_ref_id
        ? await this.getPrinterReferenceById(input.printer_ref_id, client)
        : await this.createPrinterReference(companyId, input.custom_reference!, client);

      // Multiplier: N identical machines from one submission. The reference is
      // resolved once above and shared, exactly as the asset intakes do it.
      //
      // Serial number and marker are deliberately absent from the loop body —
      // the schema rejects them above a multiplier of 1, because each names one
      // specific machine (see createPrinterSchema).
      const quantity = input.quantity ?? 1;
      const createdPrinterIds: string[] = [];

      for (let i = 0; i < quantity; i++) {
        // Re-asserted per unit, NOT once for the batch. assertCanAddPrinter
        // recounts printer_instances inside this transaction, so it sees the
        // rows earlier iterations already inserted — a shop one printer under
        // its cap therefore gets one printer and a clear error, instead of
        // slipping forty past a single up-front check.
        await this.licensingService.assertCanAddPrinter(companyId, client);

        const createdPrinter = await this.databaseService.query<{ printer_id: string }>(
        `
          INSERT INTO printer_instances (
            company_id,
            printer_ref_id,
            brand,
            model,
            serial_number,
            purchase_date,
            purchase_price,
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
            marker,
            notes
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
            $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
            $25, $26, $27, $28, $29, $30, $31
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
          input.purchase_price ?? null,
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
          input.marker ?? null,
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

        createdPrinterIds.push(createdPrinterRow.printer_id);
      }

      const createdPrinters = await Promise.all(
        createdPrinterIds.map((id) => this.getPrinterById(companyId, id, client))
      );

      // Same convention as every asset intake: a single create returns the
      // object, a multiplier batch returns the array.
      return quantity > 1 ? createdPrinters : createdPrinters[0];
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
      purchase_price: input.purchase_price,
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
          -- Identity, not just spec. Without these every nozzle of the same
          -- diameter+material renders as the same string, which makes a picker
          -- (and especially a MULTI-select picker) impossible to use: you
          -- cannot tick the right one out of three identical rows.
          ai.nozzle_name,
          ai.nozzle_brand,
          ai.location,
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

  async listNozzleCompatibility(
    companyId: string,
    printerId: string,
    window?: {
      from?: string | undefined;
      to?: string | undefined;
      // The job being inspected — its own block must not count as "busy".
      excludePieceId?: string | undefined;
      excludeBedId?: string | undefined;
    }
  ) {
    await this.getPrinterById(companyId, printerId);

    const result = await this.databaseService.query(
      `
        SELECT
          pnc.printer_id,
          pnc.nozzle_asset_id,
          pnc.confirmed_at,
          pnc.notes,
          -- Same identity fields the options list carries, so a nozzle reads
          -- identically once it's compatible as it did in the picker.
          ai.nozzle_name,
          ai.nozzle_brand,
          ai.location,
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

    // Per-nozzle schedule occupancy inside the asked window (defaults to "right
    // now"), so pickers can offer the quick busy→free switch: each row gains
    // busy_in_window + the first conflicting job's name and bounds. Nozzles are
    // physical, time-exclusive resources — stock status alone can't tell you a
    // nozzle is committed to another print at 14:00.
    const fromIso = window?.from ?? new Date().toISOString();
    const toIso = window?.to ?? new Date(Date.now() + 60_000).toISOString();
    const nozzleIds = result.rows.map((r) => (r as { nozzle_asset_id: string }).nozzle_asset_id);
    const busyById = new Map<string, { busy_with: string; busy_from: string; busy_until: string }>();
    if (nozzleIds.length > 0) {
      const collect = async (sql: string, params: unknown[]) => {
        const r = await this.databaseService.query<{
          nozzle_asset_id: string; label: string; s: string; e: string;
        }>(sql, params);
        for (const row of r.rows) {
          const prev = busyById.get(row.nozzle_asset_id);
          if (!prev || row.s < prev.busy_from) {
            busyById.set(row.nozzle_asset_id, { busy_with: row.label, busy_from: row.s, busy_until: row.e });
          }
        }
      };
      const base = [companyId, nozzleIds, fromIso, toIso];
      await collect(
        `SELECT DISTINCT ON (assigned_nozzle_asset_id)
                assigned_nozzle_asset_id AS nozzle_asset_id, piece_name AS label,
                scheduled_start_at::text AS s, scheduled_end_at::text AS e
           FROM order_pieces
          WHERE company_id = $1 AND assigned_nozzle_asset_id = ANY($2::uuid[])
            AND status IN ('scheduled','printing')
            AND scheduled_start_at < $4 AND scheduled_end_at > $3
            ${window?.excludePieceId ? "AND piece_id <> $5" : ""}
          ORDER BY assigned_nozzle_asset_id, scheduled_start_at ASC`,
        window?.excludePieceId ? [...base, window.excludePieceId] : base
      );
      try {
        await collect(
          `SELECT DISTINCT ON (assigned_nozzle_asset_id)
                  assigned_nozzle_asset_id AS nozzle_asset_id, bed_name AS label,
                  scheduled_start_at::text AS s, scheduled_end_at::text AS e
             FROM print_beds
            WHERE company_id = $1 AND assigned_nozzle_asset_id = ANY($2::uuid[])
              AND status IN ('scheduled','printing')
              AND scheduled_start_at < $4 AND scheduled_end_at > $3
              ${window?.excludeBedId ? "AND bed_id <> $5" : ""}
            ORDER BY assigned_nozzle_asset_id, scheduled_start_at ASC`,
          window?.excludeBedId ? [...base, window.excludeBedId] : base
        );
      } catch { /* print_beds not migrated yet — piece blocks alone are correct */ }
    }

    return result.rows.map((r) => {
      const busy = busyById.get((r as { nozzle_asset_id: string }).nozzle_asset_id) ?? null;
      return {
        ...(r as Record<string, unknown>),
        busy_in_window: !!busy,
        busy_with: busy?.busy_with ?? null,
        busy_from: busy?.busy_from ?? null,
        busy_until: busy?.busy_until ?? null,
      };
    });
  }

  async addNozzleCompatibility(
    companyId: string,
    printerId: string,
    input: AddCompatibleNozzleInput
  ) {
    const printer = await this.getPrinterById(companyId, printerId);

    // A resin machine has no hotend and no extruder — it cures liquid from a
    // vat — so a nozzle cannot be mounted on one at all. Only the CREATE path
    // enforced this (via printers.schemas), leaving this route free to attach
    // nozzles to a resin printer after the fact. That is how a Formlabs Form 4
    // ended up carrying a "0.40mm brass" nozzle and showing a nozzle lane on
    // the schedule board: the UI was reading real rows, not inventing them.
    // Refusing the write is the only thing that makes it structurally
    // impossible rather than merely hidden.
    if (isResinTech(printer.print_technology as string | null)) {
      throw new BadRequestException(
        "This is a resin printer — it cures resin from a tank and has no nozzle to mount."
      );
    }

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

  /**
   * The other printer instances this company owns that were built from the SAME
   * catalog reference — i.e. the physically identical machines. This is what
   * makes "do the same for all printers of this reference" answerable before the
   * operator commits to it: the UI can name the machines it is about to touch
   * instead of asking them to trust a count.
   *
   * The subject printer is deliberately excluded (it is the one being edited),
   * and a printer with no printer_ref_id has no siblings at all — a custom
   * one-off reference identifies one machine, so propagation would be a lie.
   */
  async listReferenceSiblings(companyId: string, printerId: string) {
    const printer = await this.getPrinterById(companyId, printerId);
    const refId = printer.printer_ref_id as string | null;
    if (!refId) return [];

    const result = await this.databaseService.query(
      `
        SELECT
          pi.printer_id,
          COALESCE(pr.brand, pi.brand) AS brand,
          COALESCE(pr.model, pi.model) AS model,
          COALESCE(pr.print_technology, pi.print_technology) AS print_technology,
          pi.marker,
          pi.serial_number,
          pi.location,
          -- What each sibling already has, so the confirmation can say "2 of
          -- these 3 already carry every nozzle you ticked" rather than implying
          -- the whole set is about to change.
          (SELECT count(*) FROM printer_nozzle_compatibility pnc
            WHERE pnc.company_id = pi.company_id AND pnc.printer_id = pi.printer_id
          )::int AS compatible_count
        FROM printer_instances pi
        LEFT JOIN printer_reference pr
          ON pr.printer_ref_id = pi.printer_ref_id
        WHERE pi.company_id = $1
          AND pi.printer_ref_id = $2
          AND pi.printer_id <> $3
        ORDER BY pi.created_at ASC
      `,
      [companyId, refId, printerId]
    );

    return result.rows;
  }

  /**
   * Apply a whole compatibility edit in one transaction: everything ticked is
   * added, everything unticked is removed, and either the lot lands or none of
   * it does. Replaces the per-nozzle POST loop the picker used to run.
   *
   * `apply_to_reference` extends the ADDS to every sibling printer built from
   * the same reference. Removals are NOT propagated, and that asymmetry is
   * deliberate: identical machines can legitimately hold different nozzles
   * (one has the 0.6 fitted, the drawer's other 0.6 lives by the second
   * printer), so an add is a safe statement about a machine TYPE while a
   * removal is a statement about one machine's drawer. Silently stripping
   * nozzles off four other printers because one was untidied here is the kind
   * of write an operator cannot see happening and cannot undo.
   */
  async bulkNozzleCompatibility(
    companyId: string,
    printerId: string,
    input: BulkNozzleCompatibilityInput
  ) {
    const printer = await this.getPrinterById(companyId, printerId);

    // Same rule the single-add route enforces: a resin machine cures from a
    // vat and has no hotend to mount a nozzle on.
    if (isResinTech(printer.print_technology as string | null)) {
      throw new BadRequestException(
        "This is a resin printer — it cures resin from a tank and has no nozzle to mount."
      );
    }

    // Dedupe, and never let one id sit in both lists — the add and the remove
    // would race on ordering and the result would depend on statement order
    // rather than on what the operator asked for. Remove wins is arbitrary, so
    // reject instead of guessing.
    const addIds = [...new Set(input.add ?? [])];
    const removeIds = [...new Set(input.remove ?? [])];
    const overlap = addIds.filter((id) => removeIds.includes(id));
    if (overlap.length > 0) {
      throw new BadRequestException(
        "A nozzle cannot be added and removed in the same request."
      );
    }

    // Every id being added has to be this company's, and has to be a nozzle.
    // Checked in ONE query rather than per id, and before any write, so a bad
    // id fails the whole request instead of leaving a half-applied set.
    if (addIds.length > 0) {
      const owned = await this.databaseService.query<{ asset_id: string; asset_type: string }>(
        `
          SELECT asset_id, asset_type
          FROM asset_instances
          WHERE company_id = $1
            AND asset_id = ANY($2::uuid[])
        `,
        [companyId, addIds]
      );

      if (owned.rowCount !== addIds.length) {
        throw new NotFoundException("One or more nozzle assets were not found.");
      }
      if (owned.rows.some((row) => row.asset_type !== "nozzle")) {
        throw new BadRequestException(
          "Only nozzle assets can be added to printer compatibility."
        );
      }
    }

    // Targets for the adds: this printer, plus its identical siblings when the
    // operator asked for it. Resin siblings can't exist under a shared FDM
    // reference (print_technology comes off the reference), but the filter
    // costs nothing and keeps the invariant true even for legacy rows whose
    // instance-level tech disagrees with the reference.
    let targetPrinterIds = [printerId];
    let propagatedTo = 0;
    if (input.apply_to_reference && addIds.length > 0) {
      const siblings = await this.listReferenceSiblings(companyId, printerId);
      const eligible = siblings
        .filter((s) => !isResinTech((s as { print_technology: string | null }).print_technology))
        .map((s) => (s as { printer_id: string }).printer_id);
      targetPrinterIds = [printerId, ...eligible];
      propagatedTo = eligible.length;
    }

    const counts = await this.databaseService.transaction(async (client) => {
      let linksAdded = 0;
      if (addIds.length > 0) {
        // One INSERT for the whole cross product of (target printers × ticked
        // nozzles). ON CONFLICT keeps re-ticking an already-compatible nozzle
        // idempotent, which is exactly what propagation needs — most siblings
        // already carry most of the set.
        const inserted = await this.databaseService.query(
          `
            INSERT INTO printer_nozzle_compatibility (
              printer_id,
              nozzle_asset_id,
              company_id,
              notes
            )
            SELECT p.printer_id, n.nozzle_asset_id, $3, $4
            FROM unnest($1::uuid[]) AS p(printer_id)
            CROSS JOIN unnest($2::uuid[]) AS n(nozzle_asset_id)
            ON CONFLICT (printer_id, nozzle_asset_id)
            DO UPDATE
            SET
              confirmed_at = now(),
              notes = COALESCE(EXCLUDED.notes, printer_nozzle_compatibility.notes),
              company_id = EXCLUDED.company_id
          `,
          [targetPrinterIds, addIds, companyId, input.notes ?? null],
          client
        );
        linksAdded = inserted.rowCount ?? 0;
      }

      let linksRemoved = 0;
      if (removeIds.length > 0) {
        // Local to this printer only — see the doc comment above.
        const deleted = await this.databaseService.query(
          `
            DELETE FROM printer_nozzle_compatibility
            WHERE company_id = $1
              AND printer_id = $2
              AND nozzle_asset_id = ANY($3::uuid[])
          `,
          [companyId, printerId, removeIds],
          client
        );
        linksRemoved = deleted.rowCount ?? 0;
      }

      return { linksAdded, linksRemoved };
    });

    // Read the resulting set AFTER the commit, not inside the callback:
    // listNozzleCompatibility runs its own queries on a pool connection, so
    // called from inside the transaction it would answer from outside it and
    // hand the client back the pre-edit list.
    return {
      added: addIds.length,
      removed: counts.linksRemoved,
      links_written: counts.linksAdded,
      printers_affected: targetPrinterIds.length,
      propagated_to: propagatedTo,
      compatibility: await this.listNozzleCompatibility(companyId, printerId)
    };
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
        pi.purchase_price,
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

    // Refuse to delete a printer with an active print (piece or bed) — deleting
    // it mid-run would orphan the in-flight print. The operator must complete or
    // stop it first.
    const active = await this.databaseService.query(
      `SELECT 1 FROM order_pieces
        WHERE company_id = $1 AND assigned_printer_id = $2 AND status = 'printing'
       UNION ALL
       SELECT 1 FROM print_beds
        WHERE company_id = $1 AND assigned_printer_id = $2 AND status = 'printing'
       LIMIT 1`,
      [companyId, printerId]
    );
    if (active.rowCount) {
      throw new ConflictException(
        "This printer has an active print. Complete or stop it before deleting the printer."
      );
    }

    await this.databaseService.transaction(async (client) => {
      // 0. Send every piece/bed still committed to this printer (assigned /
      //    ready / scheduled) back to the unassigned pool and release their
      //    filament reservations, re-deriving each touched order's status.
      //    Without this, deleting the printer leaves those rows pointing at a
      //    gone machine (dangling assigned_printer_id).
      await revertPrinterAssignmentsTx(client, companyId, printerId);

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
