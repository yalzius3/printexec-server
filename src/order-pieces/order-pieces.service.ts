import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { z } from "zod";
import { recordOrderHistory } from "../common/order-history";
import {
  releasePieceSpoolsTx,
  reevaluateBedAfterPieceRemoval,
  recomputeOrderStatusTx
} from "../common/cascade";
import { buildUpdateClause } from "../common/sql";
import { materialFamily, sameColor } from "../jobs/jobs.service";
import { DatabaseService, type SqlExecutor } from "../database/database.service";
import {
  createOrderPieceSchema,
  duplicateOrderPieceSchema,
  listOrderPiecesQuerySchema,
  replacePieceSpoolsSchema,
  updateOrderPieceSchema
} from "../orders/orders.schemas";

type CreateOrderPieceInput = z.infer<typeof createOrderPieceSchema>;
type DuplicateOrderPieceInput = z.infer<typeof duplicateOrderPieceSchema>;
type ListOrderPiecesQuery = z.infer<typeof listOrderPiecesQuerySchema>;
type UpdateOrderPieceInput = z.infer<typeof updateOrderPieceSchema>;
type ReplacePieceSpoolsInput = z.infer<typeof replacePieceSpoolsSchema>;

type PieceRow = {
  piece_id: string;
  company_id: string;
  order_id: string;
  bed_id: string | null;
  piece_name: string;
  description: string | null;
  required_filament_ref_id: string | null;
  required_filament_material: string | null;
  required_color: string | null;
  requires_multicolor: boolean;
  color_slots?: ColorSlotRow[] | null;
  required_nozzle_diameter_mm: string | null;
  required_nozzle_material: string | null;
  assigned_nozzle_asset_id: string | null;
  required_print_technology: string | null;
  required_multicolor_capable: boolean;
  assigned_printer_id: string | null;
  slicer_file_url: string | null;
  slicer_file_uploaded_at: string | null;
  slicer_profile: string | null;
  slicer_print_time_minutes: number | null;
  slicer_filament_used_grams: string | null;
  slicer_filament_used_mm: string | null;
  slicer_support_grams: string | null;
  slicer_layer_height_mm: string | null;
  slicer_infill_percent: number | null;
  slicer_wall_loops: number | null;
  slicer_supports_enabled: boolean | null;
  slicer_support_type: string | null;
  slicer_part_weight_grams: string | null;
  actual_print_time_minutes: number | null;
  actual_filament_used_grams: string | null;
  print_started_at: string | null;
  print_completed_at: string | null;
  scheduled_at: string | null;
  scheduled_start_at: string | null;
  scheduled_end_at: string | null;
  status: string;
  notes: string | null;
  created_at: string;
  last_updated_at: string;
  order_status: string;
  assigned_printer_label?: string | null;
  assigned_nozzle_label?: string | null;
};

type ColorSlotRow = {
  color_slot_id: string;
  sequence_order: number;
  slot_material: string;
  slot_color: string;
  slicer_grams: string | null;
};

type ReadyWorkflowData = {
  assigned_printer_id: string | null | undefined;
  assigned_nozzle_asset_id: string | null | undefined;
  slicer_file_url: string | null | undefined;
  slicer_print_time_minutes: number | null | undefined;
  slicer_filament_used_grams: string | number | null | undefined;
};

type PieceSpoolRow = {
  piece_spool_id: string;
  piece_id: string;
  spool_asset_id: string;
  planned_grams: string;
  sequence_order: number;
  filament_ref_id: string | null;
  filament_color: string | null;
  spool_label: string | null;
  remaining_grams: string | null;
  reserved_grams: string | null;
  stock_status: string;
  currently_used_in_piece_id: string | null;
};

const TECH_FIELDS = [
  "required_print_technology",
  "requires_multicolor",
  "required_filament_material",
  "required_color",
  "required_nozzle_diameter_mm",
  "required_nozzle_material",
  "required_multicolor_capable",
  "stl_file_url",
  "stl_file_uploaded_at"
] as const;

const SLICER_FIELDS = [
  "slicer_file_url",
  "slicer_file_uploaded_at",
  "slicer_print_time_minutes",
  "slicer_filament_used_grams",
  "slicer_filament_used_mm",
  "slicer_support_grams",
  "slicer_layer_height_mm",
  "slicer_infill_percent",
  "slicer_wall_loops",
  "slicer_supports_enabled",
  "slicer_support_type",
  "slicer_part_weight_grams",
  "color_slots",
  "color_slot_grams"
] as const;

const TECH_LOCKED_STATUSES = new Set(["ready", "scheduled", "printing", "done", "failed", "cancelled"]);
const SLICER_LOCKED_STATUSES = new Set(["scheduled", "printing", "done", "failed", "cancelled"]);

@Injectable()
export class OrderPiecesService {
  constructor(private readonly databaseService: DatabaseService) {}

  async listPieces(companyId: string, query: ListOrderPiecesQuery) {
    const values: unknown[] = [companyId];
    const filters = ["op.company_id = $1"];

    if (query.order_id) {
      values.push(query.order_id);
      filters.push(`op.order_id = $${values.length}`);
    }

    if (query.status) {
      values.push(query.status);
      filters.push(`op.status = $${values.length}`);
    }

    if (query.assigned_printer_id) {
      values.push(query.assigned_printer_id);
      filters.push(`op.assigned_printer_id = $${values.length}`);
    }

    if (query.search) {
      values.push(`%${query.search}%`);
      filters.push(`
        (
          op.piece_name ILIKE $${values.length}
          OR COALESCE(op.description, '') ILIKE $${values.length}
          OR COALESCE(o.order_number, '') ILIKE $${values.length}
          OR COALESCE(o.title, '') ILIKE $${values.length}
        )
      `);
    }

    const result = await this.databaseService.query(
      `
        SELECT
          op.*,
          o.order_number,
          o.title AS order_title,
          o.status AS order_status,
          COUNT(ops.piece_spool_id) AS spool_allocation_count,
          CASE
            WHEN pi.printer_id IS NOT NULL
              THEN NULLIF(TRIM(CONCAT_WS(' ', pi.brand, pi.model)), '')
            ELSE NULL
          END AS assigned_printer_label,
          CASE
            WHEN noz.asset_id IS NOT NULL
              THEN NULLIF(
                TRIM(
                  CONCAT_WS(
                    ' ',
                    noz.nozzle_material,
                    CASE
                      WHEN noz.nozzle_diameter_mm IS NOT NULL
                        THEN noz.nozzle_diameter_mm::text || 'mm'
                    END
                  )
                ) || ' Nozzle',
                ' Nozzle'
              )
            ELSE NULL
          END AS assigned_nozzle_label,
          (
            SELECT string_agg(
              COALESCE(
                NULLIF(TRIM(CONCAT_WS(' ', frs.brand, frs.material_type)), ''),
                LEFT(ops2.spool_asset_id::text, 8)
              )
              || COALESCE(' (' || NULLIF(frs.color, '') || ')', ''),
              ', '
              ORDER BY ops2.sequence_order
            )
            FROM order_piece_spools ops2
            LEFT JOIN asset_instances ais ON ais.asset_id = ops2.spool_asset_id
            LEFT JOIN filament_reference frs ON frs.filament_ref_id = ais.filament_ref_id
            WHERE ops2.piece_id = op.piece_id
          ) AS spool_labels,
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
          ) AS color_slots
        FROM order_pieces op
        INNER JOIN orders o
          ON o.order_id = op.order_id
        LEFT JOIN order_piece_spools ops
          ON ops.piece_id = op.piece_id
        LEFT JOIN printer_instances pi
          ON pi.printer_id = op.assigned_printer_id
        LEFT JOIN asset_instances noz
          ON noz.asset_id = op.assigned_nozzle_asset_id
          AND noz.company_id = op.company_id
          AND noz.asset_type = 'nozzle'
        WHERE ${filters.join(" AND ")}
        GROUP BY
          op.piece_id, o.order_id,
          pi.printer_id, pi.brand, pi.model,
          noz.asset_id, noz.nozzle_material, noz.nozzle_diameter_mm
        ORDER BY LOWER(op.piece_name) ASC, op.created_at ASC
      `,
      values
    );

    return result.rows;
  }

  async getPieceById(
    companyId: string,
    pieceId: string,
    executor?: SqlExecutor
  ) {
    const result = await this.databaseService.query<PieceRow>(
      `
        SELECT
          op.*,
          o.status AS order_status,
          CASE
            WHEN pi.printer_id IS NOT NULL
              THEN NULLIF(TRIM(CONCAT_WS(' ', pi.brand, pi.model)), '')
            ELSE NULL
          END AS assigned_printer_label,
          CASE
            WHEN noz.asset_id IS NOT NULL
              THEN NULLIF(
                TRIM(
                  CONCAT_WS(
                    ' ',
                    noz.nozzle_material,
                    CASE
                      WHEN noz.nozzle_diameter_mm IS NOT NULL
                        THEN noz.nozzle_diameter_mm::text || 'mm'
                    END
                  )
                ) || ' Nozzle',
                ' Nozzle'
              )
            ELSE NULL
          END AS assigned_nozzle_label,
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
          ) AS color_slots
        FROM order_pieces op
        INNER JOIN orders o
          ON o.order_id = op.order_id
        LEFT JOIN printer_instances pi
          ON pi.printer_id = op.assigned_printer_id
        LEFT JOIN asset_instances noz
          ON noz.asset_id = op.assigned_nozzle_asset_id
          AND noz.company_id = op.company_id
          AND noz.asset_type = 'nozzle'
        WHERE op.company_id = $1
          AND op.piece_id = $2
      `,
      [companyId, pieceId],
      executor
    );

    const row = result.rows[0];

    if (!row) {
      throw new NotFoundException("Order piece not found.");
    }

    const [spools, scheduling] = await Promise.all([
      this.listSpoolAllocations(companyId, pieceId, executor),
      this.getSchedulingDiagnostics(companyId, pieceId, executor)
    ]);

    return {
      ...row,
      spools,
      scheduling
    };
  }

  async createPiece(
    companyId: string,
    orderId: string,
    input: CreateOrderPieceInput
  ) {
    const order = await this.assertOrderExists(companyId, orderId);
    this.assertOrderOpenForPieceChanges(order.status);
    await this.validatePieceReferences(companyId, input);
    const pieceId = await this.insertPieceRecord(companyId, orderId, input);

    await this.databaseService.transaction(async (client) => {
      await this.syncOrderStatus(companyId, orderId, client);
      await this.logPieceHistory(client, companyId, pieceId, orderId, input.piece_name, "created",
        `Piece "${input.piece_name}" added.`);
    });

    return this.getPieceById(companyId, pieceId);
  }

  async updatePiece(
    companyId: string,
    pieceId: string,
    input: UpdateOrderPieceInput
  ) {
    const currentPiece = await this.getPieceById(companyId, pieceId);
    this.assertDirectPiecePatchAllowed(currentPiece, input);
    await this.validatePieceReferences(companyId, input, currentPiece);

    const derivedStatus = this.deriveWorkflowStatusAfterPatch(currentPiece, input);
    const nextStatus = derivedStatus ?? input.status;

    // color_slots / color_slot_grams are not columns on order_pieces — pull
    // them out and apply them to the companion table separately.
    const { color_slots: nextColorSlots, color_slot_grams: nextSlotGrams, ...columnInput } = input;

    const updatePayload: Record<string, unknown> = {
      ...columnInput,
      status: nextStatus
    };

    const nextMulticolor = input.requires_multicolor ?? currentPiece.requires_multicolor;

    // When the per-color slots change, keep the mirrored single-material/color
    // fields in sync with slot[0] so legacy displays and fallbacks stay correct.
    if (Array.isArray(nextColorSlots) && nextColorSlots.length > 0 && nextMulticolor) {
      updatePayload.required_filament_material = nextColorSlots[0]!.slot_material;
      updatePayload.required_color = nextColorSlots[0]!.slot_color;
    }

    const { clause, values } = buildUpdateClause(updatePayload);

    // One transaction for the whole mutation: the column update, the color-slot
    // delete/insert, the per-slot grams writes + total resync, and the order
    // status sync must all commit together or not at all — a mid-sequence
    // failure must never leave the piece half-updated.
    return this.databaseService.transaction(async (client) => {
      if (clause) {
        await this.databaseService.query(
          `
            UPDATE order_pieces
            SET ${clause}
            WHERE company_id = $${values.length + 1}
              AND piece_id = $${values.length + 2}
          `,
          [...values, companyId, pieceId],
          client
        );
      }

      // Replace the requirement slots, or clear them when leaving multicolor.
      if (Array.isArray(nextColorSlots)) {
        if (nextMulticolor && nextColorSlots.length > 0) {
          await this.insertColorSlots(companyId, pieceId, nextColorSlots, client);
        } else {
          await this.databaseService.query(
            `DELETE FROM order_piece_color_slots WHERE company_id = $1 AND piece_id = $2`,
            [companyId, pieceId],
            client
          );
        }
      } else if (input.requires_multicolor === false) {
        await this.databaseService.query(
          `DELETE FROM order_piece_color_slots WHERE company_id = $1 AND piece_id = $2`,
          [companyId, pieceId],
          client
        );
      }

      // Write per-slot slicer demand against the matching color slot, then sync
      // the piece-level total to the SUM of the slot rows (the source of truth)
      // so existing "needs grams" guards work and a partial update can't drift it.
      if (Array.isArray(nextSlotGrams)) {
        for (const entry of nextSlotGrams) {
          await this.databaseService.query(
            `
              UPDATE order_piece_color_slots
              SET slicer_grams = $3
              WHERE company_id = $1
                AND piece_id = $2
                AND sequence_order = $4
            `,
            [companyId, pieceId, entry.grams, entry.sequence_order],
            client
          );
        }
        if (nextSlotGrams.length > 0) {
          await this.databaseService.query(
            `
              UPDATE order_pieces op
              SET slicer_filament_used_grams = (
                SELECT COALESCE(SUM(slicer_grams), 0)
                  FROM order_piece_color_slots
                 WHERE company_id = $1 AND piece_id = $2
              )
              WHERE op.company_id = $1 AND op.piece_id = $2
            `,
            [companyId, pieceId],
            client
          );
        }
      }

      await this.syncOrderStatus(companyId, currentPiece.order_id, client);
      if (nextStatus && nextStatus !== currentPiece.status) {
        await this.logPieceHistory(client, companyId, pieceId, currentPiece.order_id, currentPiece.piece_name, "status_changed",
          `Piece "${currentPiece.piece_name}" moved from ${currentPiece.status} to ${nextStatus}.`);
      }

      return this.getPieceById(companyId, pieceId, client);
    });
  }

  /**
   * Delete a piece. The normal path (force=false) refuses to delete a
   * terminal piece (printing/done/failed) or one whose order is closed — the
   * same guard the Orders UI relies on. The Jobs page passes force=true to
   * hard-delete anything regardless of status.
   *
   * Either way we release the piece's spool reservations first, and if the
   * piece lived on a bed we re-evaluate that bed (dismantle / cancel / delete
   * per the cascade rules).
   */
  async deletePiece(
    companyId: string,
    pieceId: string,
    options?: { force?: boolean }
  ) {
    const force = options?.force ?? false;
    const currentPiece = await this.getPieceById(companyId, pieceId);
    const order = await this.assertOrderExists(companyId, currentPiece.order_id);

    if (!force) {
      this.assertOrderOpenForPieceChanges(order.status);
      if (["printing", "done", "failed"].includes(currentPiece.status)) {
        throw new BadRequestException(
          "Printing or completed piece records cannot be deleted."
        );
      }
    }

    await this.databaseService.transaction(async (client) => {
      // Return any reserved filament to stock before the row disappears.
      await releasePieceSpoolsTx(client, companyId, pieceId);

      await this.databaseService.query(
        `
          DELETE FROM order_pieces
          WHERE company_id = $1
            AND piece_id = $2
        `,
        [companyId, pieceId],
        client
      );

      if (currentPiece.bed_id) {
        await reevaluateBedAfterPieceRemoval(client, companyId, currentPiece.bed_id);
      }

      await this.syncOrderStatus(companyId, currentPiece.order_id, client);
      await this.logPieceHistory(client, companyId, null, currentPiece.order_id, currentPiece.piece_name, "deleted",
        `Piece "${currentPiece.piece_name}" deleted.`);
    });

    return { deleted: true, piece_id: pieceId };
  }

  /**
   * Delete several pieces in ONE transaction, then re-evaluate each affected
   * bed exactly once. This makes "remove all of a bed's pieces" settle on a
   * DELETED bed (zero left) instead of the orphaned 'disassembled' state the
   * per-piece path leaves when it disassembles on the first removal. Per-piece
   * guards, spool release, history and order re-derivation are unchanged.
   */
  async deletePieces(
    companyId: string,
    pieceIds: string[],
    options?: { force?: boolean }
  ) {
    const force = options?.force ?? false;
    const uniqueIds = [...new Set(pieceIds)];

    // Same guards the single delete applies, validated up front.
    const pieces: Array<{ piece_id: string; order_id: string; bed_id: string | null; piece_name: string; status: string }> = [];
    for (const pieceId of uniqueIds) {
      const piece = await this.getPieceById(companyId, pieceId);
      const order = await this.assertOrderExists(companyId, piece.order_id);
      if (!force) {
        this.assertOrderOpenForPieceChanges(order.status);
        if (["printing", "done", "failed"].includes(piece.status)) {
          throw new BadRequestException(
            "Printing or completed piece records cannot be deleted."
          );
        }
      }
      pieces.push(piece);
    }

    await this.databaseService.transaction(async (client) => {
      const bedIds = new Set<string>();
      const orderIds = new Set<string>();

      for (const piece of pieces) {
        await releasePieceSpoolsTx(client, companyId, piece.piece_id);
        await this.databaseService.query(
          `DELETE FROM order_pieces WHERE company_id = $1 AND piece_id = $2`,
          [companyId, piece.piece_id],
          client
        );
        if (piece.bed_id) bedIds.add(piece.bed_id);
        orderIds.add(piece.order_id);
        await this.logPieceHistory(client, companyId, null, piece.order_id, piece.piece_name, "deleted",
          `Piece "${piece.piece_name}" deleted.`);
      }

      // ONE re-evaluation per affected bed, now that every selected piece is
      // gone: all-removed → bed deleted; some kept → bed disassembled.
      for (const bedId of bedIds) {
        await reevaluateBedAfterPieceRemoval(client, companyId, bedId);
      }
      for (const orderId of orderIds) {
        await this.syncOrderStatus(companyId, orderId, client);
      }
    });

    return { deleted: uniqueIds.length, piece_ids: uniqueIds };
  }

  async duplicatePiece(
    companyId: string,
    pieceId: string,
    input: DuplicateOrderPieceInput
  ) {
    const sourcePiece = await this.getPieceById(companyId, pieceId);
    const order = await this.assertOrderExists(companyId, sourcePiece.order_id);
    this.assertOrderOpenForPieceChanges(order.status);

    const duplicateInput = this.buildCreateInputFromPiece(sourcePiece);
    // A duplicate is a brand-new physical piece, so it must be assigned from
    // scratch — never inheriting the source's printer/nozzle. Dropping these
    // makes insertPieceRecord fall back to "pending", re-entering assignment.
    delete duplicateInput.assigned_printer_id;
    delete duplicateInput.assigned_nozzle_asset_id;
    await this.validatePieceReferences(companyId, duplicateInput);

    const pieceIds = await this.databaseService.transaction(async (client) => {
      const createdIds: string[] = [];

      for (let index = 0; index < input.count; index += 1) {
        createdIds.push(
          await this.insertPieceRecord(companyId, sourcePiece.order_id, duplicateInput, client)
        );
      }

      await this.syncOrderStatus(companyId, sourcePiece.order_id, client);
      return createdIds;
    });

    return {
      created: pieceIds.length,
      piece_ids: pieceIds
    };
  }

  async replaceSpoolAllocations(
    companyId: string,
    pieceId: string,
    input: ReplacePieceSpoolsInput
  ) {
    const piece = await this.getPieceById(companyId, pieceId);

    const isMulticolor = piece.requires_multicolor && (piece.color_slots?.length ?? 0) > 0;
    const slotsBySeq = new Map<number, ColorSlotRow>(
      (piece.color_slots ?? []).map((slot) => [slot.sequence_order, slot])
    );

    return this.databaseService.transaction(async (client) => {
      this.assertSpoolReplacementAllowed(piece.status, piece.required_print_technology);

      for (const spool of input.spools) {
        const spoolRow = await this.getSpoolForValidation(companyId, spool.spool_asset_id, client);

        if (isMulticolor) {
          // Each spool fills the color slot sharing its sequence_order; validate
          // against that slot's abstract material family + free-text color.
          const slot = slotsBySeq.get(spool.sequence_order);
          if (!slot) {
            throw new BadRequestException(
              `No color slot defined for sequence ${spool.sequence_order}.`
            );
          }
          if (
            !spoolRow.filament_material ||
            materialFamily(spoolRow.filament_material) !== materialFamily(slot.slot_material)
          ) {
            throw new BadRequestException(
              `Spool material (${spoolRow.filament_material ?? "unknown"}) does not match color slot ${spool.sequence_order} (${slot.slot_material}).`
            );
          }
          if (!sameColor(spoolRow.filament_color, slot.slot_color)) {
            throw new BadRequestException(
              `Spool color does not match color slot ${spool.sequence_order} (${slot.slot_color}).`
            );
          }
        } else {
          if (piece.required_filament_ref_id && spoolRow.filament_ref_id !== piece.required_filament_ref_id) {
            throw new BadRequestException("Allocated spools must match the piece required filament reference.");
          }

          if (piece.required_color && spoolRow.filament_color !== piece.required_color) {
            throw new BadRequestException("Allocated spool color does not match the piece requirement.");
          }
        }

        if (spoolRow.stock_status === "damaged" || spoolRow.stock_status === "empty") {
          throw new BadRequestException(`Spool ${spool.spool_asset_id} is not usable for this piece.`);
        }
      }

      await this.databaseService.query(
        `
          DELETE FROM order_piece_spools
          WHERE company_id = $1
            AND piece_id = $2
        `,
        [companyId, pieceId],
        client
      );

      for (const spool of input.spools) {
        await this.databaseService.query(
          `
            INSERT INTO order_piece_spools (
              company_id,
              piece_id,
              spool_asset_id,
              planned_grams,
              sequence_order
            )
            VALUES ($1, $2, $3, $4, $5)
          `,
          [
            companyId,
            pieceId,
            spool.spool_asset_id,
            spool.planned_grams,
            spool.sequence_order
          ],
          client
        );
      }

      return this.getPieceById(companyId, pieceId, client);
    });
  }

  async unschedulePiece(companyId: string, pieceId: string) {
    return this.databaseService.transaction(async (client) => {
      const piece = await this.getPieceById(companyId, pieceId, client);

      if (piece.status !== "scheduled") {
        throw new BadRequestException("Only scheduled pieces can be unscheduled.");
      }

      await this.databaseService.query(
        `
          UPDATE order_pieces
          SET
            status = 'ready',
            scheduled_at = NULL,
            scheduled_start_at = NULL,
            scheduled_end_at = NULL
          WHERE company_id = $1
            AND piece_id = $2
        `,
        [companyId, pieceId],
        client
      );

      await this.logPieceHistory(client, companyId, pieceId, piece.order_id, piece.piece_name, "unscheduled",
        `Piece "${piece.piece_name}" unscheduled.`);

      return this.getPieceById(companyId, pieceId, client);
    });
  }

  private async listSpoolAllocations(
    companyId: string,
    pieceId: string,
    executor?: SqlExecutor
  ) {
    const result = await this.databaseService.query<PieceSpoolRow>(
      `
        SELECT
          ops.piece_spool_id,
          ops.piece_id,
          ops.spool_asset_id,
          ops.planned_grams,
          ops.sequence_order,
          ai.filament_ref_id,
          fr.color AS filament_color,
          NULLIF(
            TRIM(
              CONCAT_WS(' ', fr.brand, fr.material_type)
              || CASE WHEN fr.color IS NOT NULL THEN ' / ' || fr.color ELSE '' END
            ),
            ''
          ) AS spool_label,
          ast.remaining_grams,
          ast.reserved_grams,
          ast.status AS stock_status,
          ast.currently_used_in_piece_id
        FROM order_piece_spools ops
        INNER JOIN asset_instances ai
          ON ai.asset_id = ops.spool_asset_id
        INNER JOIN asset_stock ast
          ON ast.asset_id = ai.asset_id
        LEFT JOIN filament_reference fr
          ON fr.filament_ref_id = ai.filament_ref_id
        WHERE ops.company_id = $1
          AND ops.piece_id = $2
        ORDER BY ops.sequence_order ASC
      `,
      [companyId, pieceId],
      executor
    );

    return result.rows;
  }

  private async getSchedulingDiagnostics(
    companyId: string,
    pieceId: string,
    executor?: SqlExecutor
  ) {
    const spools = await this.listSpoolAllocations(companyId, pieceId, executor);
    const totalPlannedGrams = spools.reduce(
      (sum, spool) => sum + Number(spool.planned_grams),
      0
    );

    return {
      spool_allocation_count: spools.length,
      replacement_required: spools.length > 1,
      total_planned_grams: totalPlannedGrams
    };
  }

  private async assertOrderExists(
    companyId: string,
    orderId: string,
    executor?: SqlExecutor
  ) {
    const result = await this.databaseService.query<{ order_id: string; status: string }>(
      `
        SELECT order_id, status
        FROM orders
        WHERE company_id = $1
          AND order_id = $2
      `,
      [companyId, orderId],
      executor
    );

    if (!result.rowCount) {
      throw new BadRequestException("Order does not exist for this company.");
    }

    return result.rows[0]!;
  }

  private async insertPieceRecord(
    companyId: string,
    orderId: string,
    input: CreateOrderPieceInput,
    executor?: SqlExecutor
  ) {
    const slots = input.color_slots ?? [];
    const isMulticolor = (input.requires_multicolor ?? false) && slots.length > 0;
    // Single source of truth for the legacy single-material/color fields:
    // multicolor pieces mirror slot[0] so old displays and fallbacks keep
    // working; single-color pieces use the explicit fields.
    const mirroredMaterial = isMulticolor
      ? slots[0]!.slot_material
      : (input.required_filament_material ?? null);
    const mirroredColor = isMulticolor
      ? slots[0]!.slot_color
      : (input.required_color ?? null);

    const initialStatus = input.status ?? (
      this.pieceHasReadyWorkflowData({
        assigned_printer_id: input.assigned_printer_id ?? null,
        assigned_nozzle_asset_id: input.assigned_nozzle_asset_id ?? null,
        slicer_file_url: input.slicer_file_url ?? null,
        slicer_print_time_minutes: input.slicer_print_time_minutes ?? null,
        slicer_filament_used_grams: input.slicer_filament_used_grams ?? null
      })
        ? "ready"
        : "pending"
    );

    const created = await this.databaseService.query<{ piece_id: string }>(
      `
        INSERT INTO order_pieces (
          company_id,
          order_id,
          piece_name,
          description,
          required_filament_ref_id,
          required_color,
          requires_multicolor,
          required_nozzle_diameter_mm,
          required_nozzle_material,
          assigned_nozzle_asset_id,
          required_print_technology,
          required_multicolor_capable,
          assigned_printer_id,
          slicer_file_url,
          slicer_file_uploaded_at,
          slicer_profile,
          slicer_print_time_minutes,
          slicer_filament_used_grams,
          slicer_filament_used_mm,
          slicer_support_grams,
          slicer_layer_height_mm,
          slicer_infill_percent,
          slicer_wall_loops,
          slicer_supports_enabled,
          slicer_support_type,
          slicer_part_weight_grams,
          actual_print_time_minutes,
          actual_filament_used_grams,
          print_started_at,
          print_completed_at,
          status,
          notes,
          required_filament_material,
          stl_file_url,
          stl_file_uploaded_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
          $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26,
          $27, $28, $29, $30, $31, $32, $33, $34,
          CASE WHEN $34::text IS NOT NULL THEN now() ELSE NULL END
        )
        RETURNING piece_id
      `,
      [
        companyId,
        orderId,
        input.piece_name,
        input.description ?? null,
        input.required_filament_ref_id ?? null,
        mirroredColor,
        input.requires_multicolor ?? false,
        input.required_nozzle_diameter_mm ?? null,
        input.required_nozzle_material ?? null,
        input.assigned_nozzle_asset_id ?? null,
        input.required_print_technology ?? null,
        input.required_multicolor_capable ?? false,
        input.assigned_printer_id ?? null,
        input.slicer_file_url ?? null,
        input.slicer_file_uploaded_at ?? null,
        input.slicer_profile ?? null,
        input.slicer_print_time_minutes ?? null,
        input.slicer_filament_used_grams ?? null,
        input.slicer_filament_used_mm ?? null,
        input.slicer_support_grams ?? null,
        input.slicer_layer_height_mm ?? null,
        input.slicer_infill_percent ?? null,
        input.slicer_wall_loops ?? null,
        input.slicer_supports_enabled ?? null,
        input.slicer_support_type ?? null,
        input.slicer_part_weight_grams ?? null,
        input.actual_print_time_minutes ?? null,
        input.actual_filament_used_grams ?? null,
        input.print_started_at ?? null,
        input.print_completed_at ?? null,
        initialStatus,
        input.notes ?? null,
        mirroredMaterial,
        input.stl_file_url ?? null
      ],
      executor
    );

    const row = created.rows[0];

    if (!row) {
      throw new BadRequestException("Order piece insert failed.");
    }

    if (isMulticolor) {
      await this.insertColorSlots(companyId, row.piece_id, slots, executor);
    }

    return row.piece_id;
  }

  // Replace the per-color requirement rows for a piece. Sequence is the array
  // index + 1; it is also the join key back to order_piece_spools at
  // reservation time. slicer_grams stays NULL until the slicer step.
  private async insertColorSlots(
    companyId: string,
    pieceId: string,
    slots: { slot_material: string; slot_color: string }[],
    executor?: SqlExecutor
  ) {
    await this.databaseService.query(
      `DELETE FROM order_piece_color_slots WHERE company_id = $1 AND piece_id = $2`,
      [companyId, pieceId],
      executor
    );

    for (let index = 0; index < slots.length; index += 1) {
      const slot = slots[index]!;
      await this.databaseService.query(
        `
          INSERT INTO order_piece_color_slots (
            company_id, piece_id, sequence_order, slot_material, slot_color
          )
          VALUES ($1, $2, $3, $4, $5)
        `,
        [companyId, pieceId, index + 1, slot.slot_material, slot.slot_color],
        executor
      );
    }
  }

  private async validatePieceReferences(
    companyId: string,
    input: Partial<UpdateOrderPieceInput>,
    currentPiece?: PieceRow,
    executor?: SqlExecutor
  ) {
    const nextPrintTechnology =
      input.required_print_technology !== undefined
        ? input.required_print_technology
        : currentPiece?.required_print_technology;
    const nextAssignedPrinterId =
      input.assigned_printer_id !== undefined
        ? input.assigned_printer_id
        : currentPiece?.assigned_printer_id;
    const nextAssignedNozzleAssetId =
      input.assigned_nozzle_asset_id !== undefined
        ? input.assigned_nozzle_asset_id
        : currentPiece?.assigned_nozzle_asset_id;
    const nextRequiredMulticolorCapable =
      input.required_multicolor_capable !== undefined
        ? input.required_multicolor_capable
        : currentPiece?.required_multicolor_capable;
    const nextRequiredNozzleDiameter =
      input.required_nozzle_diameter_mm !== undefined
        ? input.required_nozzle_diameter_mm
        : currentPiece?.required_nozzle_diameter_mm
          ? Number(currentPiece.required_nozzle_diameter_mm)
          : null;
    const nextRequiredNozzleMaterial =
      input.required_nozzle_material !== undefined
        ? input.required_nozzle_material
        : currentPiece?.required_nozzle_material;

    if (input.required_filament_ref_id) {
      const filament = await this.databaseService.query(
        `
          SELECT filament_ref_id
          FROM filament_reference
          WHERE filament_ref_id = $1
        `,
        [input.required_filament_ref_id],
        executor
      );

      if (!filament.rowCount) {
        throw new BadRequestException("required_filament_ref_id does not exist.");
      }
    }

    let printerProfile:
      | {
          printer_id: string;
          print_technology: string;
          is_multicolor: boolean;
        }
      | null = null;
    let nozzleProfile:
      | {
          nozzle_asset_id: string;
          nozzle_diameter_mm: string | null;
          nozzle_material: string | null;
        }
      | null = null;

    if (nextAssignedPrinterId) {
      printerProfile = await this.getPrinterAssignmentProfile(companyId, nextAssignedPrinterId, executor);

      if (
        nextPrintTechnology &&
        printerProfile.print_technology !== nextPrintTechnology
      ) {
        throw new BadRequestException("assigned_printer_id does not match required_print_technology.");
      }

      if (nextRequiredMulticolorCapable && !printerProfile.is_multicolor) {
        throw new BadRequestException("assigned_printer_id is not multicolor-capable.");
      }
    }

    if (nextAssignedNozzleAssetId) {
      nozzleProfile = await this.getNozzleAssignmentProfile(companyId, nextAssignedNozzleAssetId, executor);

      if (
        nextRequiredNozzleDiameter !== null &&
        nextRequiredNozzleDiameter !== undefined &&
        Number(nozzleProfile.nozzle_diameter_mm) !== Number(nextRequiredNozzleDiameter)
      ) {
        throw new BadRequestException("assigned_nozzle_asset_id does not match required_nozzle_diameter_mm.");
      }

      if (
        nextRequiredNozzleMaterial &&
        nozzleProfile.nozzle_material !== nextRequiredNozzleMaterial
      ) {
        throw new BadRequestException("assigned_nozzle_asset_id does not match required_nozzle_material.");
      }
    }

    if (nextAssignedPrinterId && nextAssignedNozzleAssetId) {
      const compatibility = await this.databaseService.query(
        `
          SELECT 1
          FROM printer_nozzle_compatibility
          WHERE company_id = $1
            AND printer_id = $2
            AND nozzle_asset_id = $3
        `,
        [companyId, nextAssignedPrinterId, nextAssignedNozzleAssetId],
        executor
      );

      if (!compatibility.rowCount) {
        throw new BadRequestException(
          "assigned_nozzle_asset_id is not configured as compatible with assigned_printer_id."
        );
      }
    }
  }

  private async assertSpoolExists(
    companyId: string,
    spoolAssetId: string,
    executor?: SqlExecutor
  ) {
    const spool = await this.databaseService.query<{ asset_type: string }>(
      `
        SELECT asset_type
        FROM asset_instances
        WHERE company_id = $1
          AND asset_id = $2
      `,
      [companyId, spoolAssetId],
      executor
    );

    const row = spool.rows[0];

    if (!row || row.asset_type !== "filament_spool") {
      throw new BadRequestException("spool_asset_id must be a filament spool asset.");
    }
  }

  private async getSpoolForValidation(
    companyId: string,
    spoolAssetId: string,
    executor?: SqlExecutor
  ) {
    const spool = await this.databaseService.query<{
      asset_type: string;
      filament_ref_id: string | null;
      filament_color: string | null;
      filament_material: string | null;
      stock_status: string;
    }>(
      `
        SELECT
          ai.asset_type,
          ai.filament_ref_id,
          fr.color AS filament_color,
          fr.material_type AS filament_material,
          ast.status AS stock_status
        FROM asset_instances ai
        INNER JOIN asset_stock ast
          ON ast.asset_id = ai.asset_id
        LEFT JOIN filament_reference fr
          ON fr.filament_ref_id = ai.filament_ref_id
        WHERE ai.company_id = $1
          AND ai.asset_id = $2
      `,
      [companyId, spoolAssetId],
      executor
    );

    const row = spool.rows[0];

    if (!row || row.asset_type !== "filament_spool") {
      throw new BadRequestException("spool_asset_id must be a filament spool asset.");
    }

    return row;
  }

  private async assertNozzleExists(
    companyId: string,
    nozzleAssetId: string,
    executor?: SqlExecutor
  ) {
    const nozzle = await this.databaseService.query<{ asset_type: string }>(
      `
        SELECT asset_type
        FROM asset_instances
        WHERE company_id = $1
          AND asset_id = $2
      `,
      [companyId, nozzleAssetId],
      executor
    );

    const row = nozzle.rows[0];

    if (!row || row.asset_type !== "nozzle") {
      throw new BadRequestException("assigned_nozzle_asset_id must be a nozzle asset.");
    }
  }

  private async getPrinterAssignmentProfile(
    companyId: string,
    printerId: string,
    executor?: SqlExecutor
  ) {
    const printer = await this.databaseService.query<{
      printer_id: string;
      print_technology: string;
      is_multicolor: boolean;
    }>(
      `
        SELECT
          pi.printer_id,
          COALESCE(pr.print_technology, pi.print_technology) AS print_technology,
          COALESCE(pr.is_multicolor, pi.is_multicolor) AS is_multicolor
        FROM printer_instances pi
        LEFT JOIN printer_reference pr
          ON pr.printer_ref_id = pi.printer_ref_id
        WHERE pi.company_id = $1
          AND pi.printer_id = $2
      `,
      [companyId, printerId],
      executor
    );

    const row = printer.rows[0];

    if (!row) {
      throw new BadRequestException("assigned_printer_id does not exist for this company.");
    }

    return row;
  }

  private async getNozzleAssignmentProfile(
    companyId: string,
    nozzleAssetId: string,
    executor?: SqlExecutor
  ) {
    const nozzle = await this.databaseService.query<{
      nozzle_asset_id: string;
      nozzle_diameter_mm: string | null;
      nozzle_material: string | null;
    }>(
      `
        SELECT
          ai.asset_id AS nozzle_asset_id,
          ai.nozzle_diameter_mm,
          ai.nozzle_material
        FROM asset_instances ai
        WHERE ai.company_id = $1
          AND ai.asset_id = $2
          AND ai.asset_type = 'nozzle'
      `,
      [companyId, nozzleAssetId],
      executor
    );

    const row = nozzle.rows[0];

    if (!row) {
      throw new BadRequestException("assigned_nozzle_asset_id must be a nozzle asset.");
    }

    return row;
  }

  private derivePrintTimeMinutes(
    startedAt: string | null,
    finishedAt: string
  ) {
    if (!startedAt) {
      return null;
    }

    const durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();

    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      return null;
    }

    return Math.max(1, Math.round(durationMs / 60000));
  }

  private assertOrderOpenForPieceChanges(orderStatus: string) {
    if (["completed", "cancelled"].includes(orderStatus)) {
      throw new BadRequestException(
        "Pieces cannot be added to completed or cancelled orders. Reopen the order first."
      );
    }
  }

  private assertDirectPiecePatchAllowed(
    currentPiece: PieceRow,
    input: UpdateOrderPieceInput
  ) {
    const hasPatchedField = (fields: readonly (keyof UpdateOrderPieceInput)[]) =>
      fields.some((field) => input[field] !== undefined);

    if (hasPatchedField(TECH_FIELDS) && TECH_LOCKED_STATUSES.has(currentPiece.status)) {
      throw new ForbiddenException("Tech details cannot be edited once a piece is ready for production.");
    }

    if (hasPatchedField(SLICER_FIELDS) && SLICER_LOCKED_STATUSES.has(currentPiece.status)) {
      throw new ForbiddenException("Slicer details cannot be edited once a piece is scheduled.");
    }

    if (input.status && ["scheduled", "printing", "done", "failed"].includes(input.status)) {
      throw new BadRequestException(
        "Use the dedicated schedule/start/complete/fail endpoints for workflow-managed piece statuses."
      );
    }

    if (
      currentPiece.status === "printing" &&
      (input.assigned_printer_id !== undefined ||
        input.assigned_nozzle_asset_id !== undefined ||
        input.required_filament_ref_id !== undefined ||
        input.status === "cancelled")
    ) {
      throw new BadRequestException(
        "Printing pieces cannot have core assignments changed through direct patching. Use execution endpoints instead."
      );
    }

    if (input.status === "ready") {
      const nextSlicerFileUrl =
        input.slicer_file_url !== undefined ? input.slicer_file_url : currentPiece.slicer_file_url;
      const nextPrintTime =
        input.slicer_print_time_minutes !== undefined
          ? input.slicer_print_time_minutes
          : currentPiece.slicer_print_time_minutes;
      const nextFilamentUsed =
        input.slicer_filament_used_grams !== undefined
          ? input.slicer_filament_used_grams
          : currentPiece.slicer_filament_used_grams
            ? Number(currentPiece.slicer_filament_used_grams)
            : null;
      const nextAssignedPrinterId =
        input.assigned_printer_id !== undefined
          ? input.assigned_printer_id
          : currentPiece.assigned_printer_id;
      const nextAssignedNozzleAssetId =
        input.assigned_nozzle_asset_id !== undefined
          ? input.assigned_nozzle_asset_id
          : currentPiece.assigned_nozzle_asset_id;

      if (!nextSlicerFileUrl || !nextPrintTime || !nextFilamentUsed) {
        throw new BadRequestException(
          "A piece needs slicer file, slicer print time, and slicer filament usage before it can be marked ready."
        );
      }

      if (!nextAssignedPrinterId) {
        throw new BadRequestException("A piece needs an assigned printer before it can be marked ready.");
      }

      if (!nextAssignedNozzleAssetId) {
        throw new BadRequestException("A piece needs an assigned nozzle before it can be marked ready.");
      }
    }
  }

  private deriveWorkflowStatusAfterPatch(
    currentPiece: PieceRow,
    input: UpdateOrderPieceInput
  ) {
    if (input.status !== undefined) {
      return input.status;
    }

    if (["scheduled", "printing", "done", "failed", "cancelled"].includes(currentPiece.status)) {
      return undefined;
    }

    const nextPiece = {
      ...currentPiece,
      ...input
    };

    if (this.pieceHasReadyWorkflowData(nextPiece)) {
      return "ready";
    }

    return undefined;
  }

  private buildCreateInputFromPiece(piece: PieceRow): CreateOrderPieceInput {
    return {
      piece_name: piece.piece_name,
      description: piece.description ?? undefined,
      required_filament_ref_id: piece.required_filament_ref_id ?? undefined,
      required_filament_material: piece.required_filament_material ?? undefined,
      required_color: piece.required_color ?? undefined,
      requires_multicolor: piece.requires_multicolor,
      // Carry the per-color requirement (material+color) into the duplicate; the
      // per-slot slicer grams are deliberately dropped — a duplicate re-slices.
      color_slots:
        piece.requires_multicolor && piece.color_slots && piece.color_slots.length > 0
          ? piece.color_slots.map((slot) => ({
              slot_material: slot.slot_material,
              slot_color: slot.slot_color
            }))
          : undefined,
      required_nozzle_diameter_mm: this.parseOptionalNumericValue(piece.required_nozzle_diameter_mm),
      required_nozzle_material: piece.required_nozzle_material
        ? piece.required_nozzle_material as CreateOrderPieceInput["required_nozzle_material"]
        : undefined,
      assigned_nozzle_asset_id: piece.assigned_nozzle_asset_id ?? undefined,
      required_print_technology: piece.required_print_technology
        ? piece.required_print_technology as CreateOrderPieceInput["required_print_technology"]
        : undefined,
      required_multicolor_capable: piece.required_multicolor_capable,
      assigned_printer_id: piece.assigned_printer_id ?? undefined,
      slicer_file_url: piece.slicer_file_url ?? undefined,
      slicer_file_uploaded_at: piece.slicer_file_uploaded_at ?? undefined,
      slicer_profile: piece.slicer_profile ?? undefined,
      slicer_print_time_minutes: piece.slicer_print_time_minutes ?? undefined,
      slicer_filament_used_grams: this.parseOptionalNumericValue(piece.slicer_filament_used_grams),
      slicer_filament_used_mm: this.parseOptionalNumericValue(piece.slicer_filament_used_mm),
      slicer_support_grams: this.parseOptionalNumericValue(piece.slicer_support_grams),
      slicer_layer_height_mm: this.parseOptionalNumericValue(piece.slicer_layer_height_mm),
      slicer_infill_percent: piece.slicer_infill_percent ?? undefined,
      slicer_wall_loops: piece.slicer_wall_loops ?? undefined,
      slicer_supports_enabled: piece.slicer_supports_enabled ?? undefined,
      slicer_support_type: piece.slicer_support_type ?? undefined,
      slicer_part_weight_grams: this.parseOptionalNumericValue(piece.slicer_part_weight_grams),
      notes: piece.notes ?? undefined
    };
  }

  private parseOptionalNumericValue(value: string | number | null | undefined) {
    if (value === null || value === undefined || value === "") {
      return undefined;
    }

    const parsedValue = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsedValue) ? parsedValue : undefined;
  }

  private pieceHasReadyWorkflowData(piece: ReadyWorkflowData) {
    return Boolean(
      piece.slicer_file_url &&
      piece.slicer_print_time_minutes &&
      piece.slicer_filament_used_grams &&
      piece.assigned_printer_id &&
      piece.assigned_nozzle_asset_id
    );
  }

  private assertSpoolReplacementAllowed(pieceStatus: string, printTechnology: string | null) {
    if (printTechnology && printTechnology !== "FDM") {
      throw new BadRequestException("Spool allocations are only used for FDM pieces in phase 1.");
    }

    if (["printing", "done", "failed", "cancelled"].includes(pieceStatus)) {
      throw new BadRequestException(
        "Spool allocations cannot be changed once a piece is printing or already terminal."
      );
    }
  }

  private async syncOrderStatus(
    companyId: string,
    orderId: string,
    executor: SqlExecutor
  ) {
    // Single source of truth lives in common/cascade so the pieces service,
    // the jobs service and the bed cascade all derive identically.
    await recomputeOrderStatusTx(executor, companyId, orderId);
  }

  private async logPieceHistory(
    executor: SqlExecutor,
    companyId: string,
    pieceId: string | null,
    orderId: string,
    pieceName: string,
    eventType: string,
    description: string
  ) {
    const orderRow = await this.databaseService.query<{ order_number: string }>(
      `SELECT order_number FROM orders WHERE order_id = $1 AND company_id = $2`,
      [orderId, companyId],
      executor
    );
    await recordOrderHistory(executor, companyId, {
      entityType: "piece",
      eventType,
      orderId,
      orderNumber: orderRow.rows[0]?.order_number ?? null,
      pieceId,
      pieceName,
      description
    });
  }
}
