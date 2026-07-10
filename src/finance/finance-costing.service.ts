import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { z } from "zod";
import { buildUpdateClause } from "../common/sql";
import { DatabaseService } from "../database/database.service";
import type { createCostingSchema, updateCostingSchema } from "./finance.schemas";

// ════════════════════════════════════════════════════════════════
// FinanceCostingService — reusable capital-recovery / margin calculators.
//
// per-order recovery margin:
//   asset_recovery -> asset_cost / (payback_months * expected_volume_per_month)
//   manual         -> a directly-entered amount
// computed_value is stored on every write so the Orders pricing screen can SUM
// the active variables cheaply as an optional quote markup.
// ════════════════════════════════════════════════════════════════

type CreateCostingInput = z.infer<typeof createCostingSchema>;
type UpdateCostingInput = z.infer<typeof updateCostingSchema>;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// The one costing equation, shared by create + update so they never drift.
function computeValue(input: {
  kind: "asset_recovery" | "manual";
  asset_cost?: number | null | undefined;
  payback_months?: number | null | undefined;
  expected_volume_per_month?: number | null | undefined;
  manual_value?: number | null | undefined;
}): number {
  if (input.kind === "manual") {
    return round2(Math.max(0, input.manual_value ?? 0));
  }
  const cost = input.asset_cost ?? 0;
  const months = input.payback_months ?? 0;
  const volume = input.expected_volume_per_month ?? 0;
  const denom = months * volume;
  if (cost <= 0 || denom <= 0) return 0;
  return round2(cost / denom);
}

@Injectable()
export class FinanceCostingService {
  constructor(private readonly databaseService: DatabaseService) {}

  async list(companyId: string) {
    const result = await this.databaseService.query(
      `
        SELECT costing_id, name, kind, asset_id, asset_kind, asset_label,
               asset_cost::text, payback_months, expected_volume_per_month::text,
               computed_value::text, is_active, notes, created_at, updated_at
        FROM costing_variables
        WHERE company_id = $1
        ORDER BY is_active DESC, name
      `,
      [companyId]
    );
    return result.rows;
  }

  // The number the Orders quotation screen reads: the total per-order recovery
  // margin across every ACTIVE variable, plus the breakdown for display.
  async summary(companyId: string) {
    const result = await this.databaseService.query<{
      costing_id: string;
      name: string;
      computed_value: string;
    }>(
      `
        SELECT costing_id, name, computed_value::text
        FROM costing_variables
        WHERE company_id = $1 AND is_active = TRUE AND computed_value > 0
        ORDER BY name
      `,
      [companyId]
    );
    const perOrder = result.rows.reduce((s, r) => s + Number(r.computed_value), 0);
    return {
      per_order_recovery: round2(perOrder).toFixed(2),
      active_count: result.rows.length,
      variables: result.rows
    };
  }

  // Printers a recovery plan can be built against (cost snapshot for the picker).
  async recoverableAssets(companyId: string) {
    const printers = await this.databaseService.query(
      `
        SELECT
          pi.printer_id AS asset_id,
          'printer'      AS asset_kind,
          pi.purchase_price::text AS asset_cost,
          NULLIF(TRIM(COALESCE(pr.brand, pi.brand, '') || ' ' || COALESCE(pr.model, pi.model, '')), '') AS label,
          pi.serial_number
        FROM printer_instances pi
        LEFT JOIN printer_reference pr ON pr.printer_ref_id = pi.printer_ref_id
        WHERE pi.company_id = $1 AND pi.purchase_price > 0
        ORDER BY label NULLS LAST, pi.created_at DESC
      `,
      [companyId]
    );
    return printers.rows.map((r: any) => ({
      asset_id: r.asset_id,
      asset_kind: r.asset_kind,
      asset_cost: r.asset_cost,
      label: r.label ?? `Printer ${r.serial_number ?? ""}`.trim()
    }));
  }

  async create(companyId: string, userId: string, input: CreateCostingInput) {
    const computed = computeValue(input);
    const result = await this.databaseService.query<{ costing_id: string }>(
      `
        INSERT INTO costing_variables
          (company_id, name, kind, asset_id, asset_kind, asset_label, asset_cost,
           payback_months, expected_volume_per_month, computed_value, notes, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING costing_id
      `,
      [
        companyId,
        input.name,
        input.kind,
        input.asset_id ?? null,
        input.asset_kind ?? null,
        input.asset_label ?? null,
        input.asset_cost ?? null,
        input.payback_months ?? null,
        input.expected_volume_per_month ?? null,
        computed,
        input.notes ?? null,
        userId
      ]
    );
    return { costing_id: result.rows[0]!.costing_id, computed_value: computed.toFixed(2) };
  }

  async update(companyId: string, costingId: string, input: UpdateCostingInput) {
    const existing = await this.databaseService.query<{
      kind: "asset_recovery" | "manual";
      asset_cost: string | null;
      payback_months: number | null;
      expected_volume_per_month: string | null;
      computed_value: string;
    }>(
      `SELECT kind, asset_cost::text, payback_months, expected_volume_per_month::text, computed_value::text
       FROM costing_variables WHERE company_id = $1 AND costing_id = $2`,
      [companyId, costingId]
    );
    const row = existing.rows[0];
    if (!row) throw new NotFoundException("Costing variable not found.");

    // Recompute from the merged (existing + patched) inputs so the stored
    // per-order value always matches the current parameters.
    const merged = {
      kind: (input.kind ?? row.kind) as "asset_recovery" | "manual",
      asset_cost: input.asset_cost !== undefined ? input.asset_cost : row.asset_cost != null ? Number(row.asset_cost) : null,
      payback_months: input.payback_months !== undefined ? input.payback_months : row.payback_months,
      expected_volume_per_month:
        input.expected_volume_per_month !== undefined
          ? input.expected_volume_per_month
          : row.expected_volume_per_month != null
            ? Number(row.expected_volume_per_month)
            : null,
      manual_value: input.manual_value !== undefined ? input.manual_value : Number(row.computed_value)
    };
    const computed = computeValue(merged);

    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.kind !== undefined) patch.kind = input.kind;
    if (input.asset_id !== undefined) patch.asset_id = input.asset_id;
    if (input.asset_kind !== undefined) patch.asset_kind = input.asset_kind;
    if (input.asset_label !== undefined) patch.asset_label = input.asset_label;
    if (input.asset_cost !== undefined) patch.asset_cost = input.asset_cost;
    if (input.payback_months !== undefined) patch.payback_months = input.payback_months;
    if (input.expected_volume_per_month !== undefined) patch.expected_volume_per_month = input.expected_volume_per_month;
    if (input.is_active !== undefined) patch.is_active = input.is_active;
    if (input.notes !== undefined) patch.notes = input.notes;
    patch.computed_value = computed;

    const { clause, values } = buildUpdateClause(patch, 3);
    if (!clause) throw new BadRequestException("Nothing to update.");
    const result = await this.databaseService.query(
      `
        UPDATE costing_variables
        SET ${clause}, updated_at = NOW()
        WHERE company_id = $1 AND costing_id = $2
        RETURNING costing_id, computed_value::text
      `,
      [companyId, costingId, ...values]
    );
    return result.rows[0];
  }

  async remove(companyId: string, costingId: string) {
    const result = await this.databaseService.query(
      `DELETE FROM costing_variables WHERE company_id = $1 AND costing_id = $2`,
      [companyId, costingId]
    );
    if (result.rowCount === 0) throw new NotFoundException("Costing variable not found.");
    return { deleted: true };
  }
}
