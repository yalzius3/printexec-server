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

  // ── Constants (default profit margin, avg orders/month) ─────────────────────
  // Effective value = override ?? auto ?? fallback. auto_value is recomputed
  // from >= 2 months of order history; until then override/fallback stands.

  private static readonly CONSTANTS = [
    { key: "default_profit_margin_pct", label: "Default profit margin", unit: "%", fallback: 30 },
    { key: "avg_orders_per_month", label: "Average orders / month", unit: "orders", fallback: 0 }
  ] as const;

  async getConstants(companyId: string) {
    // Recompute the auto values from history, but only once the tenant has at
    // least two full months of orders (before that, the numbers are noise).
    const stats = await this.databaseService.query<{
      total: string;
      full_months: string | null;
      avg_profit: string | null;
    }>(
      `
        SELECT
          COUNT(*)::text AS total,
          (date_part('year',  age(CURRENT_DATE, MIN(created_at)::date)) * 12
           + date_part('month', age(CURRENT_DATE, MIN(created_at)::date)))::int::text AS full_months,
          AVG(profit_pct)::text AS avg_profit
        FROM orders
        WHERE company_id = $1
      `,
      [companyId]
    );
    const total = Number(stats.rows[0]?.total ?? 0);
    const fullMonths = Number(stats.rows[0]?.full_months ?? 0);
    const avgProfit = stats.rows[0]?.avg_profit != null ? Number(stats.rows[0].avg_profit) : null;

    const autos: Record<string, number | null> = {
      default_profit_margin_pct: null,
      avg_orders_per_month: null
    };
    if (fullMonths >= 2 && total > 0) {
      autos.avg_orders_per_month = round2(total / Math.max(1, fullMonths));
      if (avgProfit != null) autos.default_profit_margin_pct = round2(avgProfit);
    }

    for (const key of Object.keys(autos)) {
      if (autos[key] != null) {
        await this.databaseService.query(
          `
            INSERT INTO finance_constants (company_id, key, auto_value, auto_computed_at)
            VALUES ($1, $2, $3, now())
            ON CONFLICT (company_id, key)
            DO UPDATE SET auto_value = EXCLUDED.auto_value, auto_computed_at = now()
          `,
          [companyId, key, autos[key]]
        );
      }
    }

    const rows = await this.databaseService.query<{
      key: string;
      override_value: string | null;
      auto_value: string | null;
      auto_computed_at: string | null;
    }>(
      `SELECT key, override_value::text, auto_value::text, auto_computed_at
       FROM finance_constants WHERE company_id = $1`,
      [companyId]
    );
    const byKey = new Map(rows.rows.map((r) => [r.key, r]));

    return FinanceCostingService.CONSTANTS.map((c) => {
      const row = byKey.get(c.key);
      const override = row?.override_value != null ? Number(row.override_value) : null;
      const auto = row?.auto_value != null ? Number(row.auto_value) : null;
      const effective = override ?? auto ?? c.fallback;
      const source = override != null ? "override" : auto != null ? "auto" : "default";
      return {
        key: c.key,
        label: c.label,
        unit: c.unit,
        effective: String(effective),
        auto: auto != null ? String(auto) : null,
        override: override != null ? String(override) : null,
        source,
        auto_computed_at: row?.auto_computed_at ?? null
      };
    });
  }

  async updateConstant(companyId: string, key: string, override: number | null) {
    if (!FinanceCostingService.CONSTANTS.some((c) => c.key === key)) {
      throw new NotFoundException("Unknown constant.");
    }
    await this.databaseService.query(
      `
        INSERT INTO finance_constants (company_id, key, override_value, updated_at)
        VALUES ($1, $2, $3, now())
        ON CONFLICT (company_id, key)
        DO UPDATE SET override_value = EXCLUDED.override_value, updated_at = now()
      `,
      [companyId, key, override]
    );
    return this.getConstants(companyId);
  }

  // ── Auto-derived cost factors for the Costing page ──────────────────────────
  // Read straight from the tenant's live data. All informational (no ledger).
  async costFactors(companyId: string) {
    const [company, materials, payroll, rent, printers, recovery] = await Promise.all([
      this.databaseService.query<{ electricity_price_per_kwh: string | null }>(
        `SELECT electricity_price_per_kwh FROM companies WHERE company_id = $1`,
        [companyId]
      ),
      // Avg filament price per gram per material (priced parent spools only).
      this.databaseService.query<{ material_type: string; price_per_gram: string }>(
        `
          SELECT fr.material_type,
                 (SUM(ai.purchase_price) / NULLIF(SUM(ai.initial_grams), 0))::text AS price_per_gram
          FROM asset_instances ai
          JOIN filament_reference fr ON fr.filament_ref_id = ai.filament_ref_id
          WHERE ai.company_id = $1
            AND ai.asset_type = 'filament_spool'
            AND ai.parent_asset_id IS NULL
            AND ai.purchase_price > 0
            AND ai.initial_grams > 0
            AND fr.material_type IS NOT NULL
          GROUP BY fr.material_type
          ORDER BY fr.material_type
        `,
        [companyId]
      ),
      // Payroll: total monthly salary + headcount (any finance user may see it).
      this.databaseService.query<{ monthly: string; headcount: string }>(
        `
          SELECT COALESCE(SUM(monthly_salary), 0)::text AS monthly,
                 COUNT(*) FILTER (WHERE monthly_salary IS NOT NULL AND monthly_salary > 0)::text AS headcount
          FROM users WHERE company_id = $1
        `,
        [companyId]
      ),
      // Fixed monthly recurring cost (Rent, ...).
      this.databaseService.query<{ monthly: string; count: string }>(
        `
          SELECT COALESCE(SUM(amount), 0)::text AS monthly, COUNT(*)::text AS count
          FROM recurring_bills
          WHERE company_id = $1 AND is_active = TRUE AND cadence = 'monthly'
        `,
        [companyId]
      ),
      // Machines, for electricity-per-machine-hour (power_watts, 230W fallback).
      this.databaseService.query<{ avg_watts: string | null; machines: string }>(
        `
          SELECT AVG(COALESCE(power_watts, 230))::text AS avg_watts, COUNT(*)::text AS machines
          FROM printer_instances WHERE company_id = $1
        `,
        [companyId]
      ),
      this.databaseService.query<{ avg_recovery: string | null; count: string }>(
        `
          SELECT AVG(computed_value)::text AS avg_recovery, COUNT(*)::text AS count
          FROM costing_variables WHERE company_id = $1 AND is_active = TRUE AND computed_value > 0
        `,
        [companyId]
      )
    ]);

    const rate = company.rows[0]?.electricity_price_per_kwh;
    const rateNum = rate != null && rate !== "" ? Number(rate) : 0;
    const avgWatts = printers.rows[0]?.avg_watts != null ? Number(printers.rows[0].avg_watts) : 230;
    // kWh per machine-hour = watts/1000; × rate = cost per machine-hour.
    const elecPerMachineHour = round2((avgWatts / 1000) * rateNum);

    return {
      electricity_per_kwh: rateNum ? rateNum.toFixed(4) : "0",
      avg_electricity_per_machine_hour: elecPerMachineHour.toFixed(4),
      machine_count: Number(printers.rows[0]?.machines ?? 0),
      filament_avg_prices: materials.rows.map((m) => ({
        material: m.material_type,
        price_per_gram: Number(m.price_per_gram).toFixed(4)
      })),
      payroll_monthly: payroll.rows[0]?.monthly ?? "0",
      payroll_headcount: Number(payroll.rows[0]?.headcount ?? 0),
      rent_monthly: rent.rows[0]?.monthly ?? "0",
      recurring_count: Number(rent.rows[0]?.count ?? 0),
      avg_recovery_per_order: recovery.rows[0]?.avg_recovery != null ? round2(Number(recovery.rows[0].avg_recovery)).toFixed(2) : "0",
      recovery_count: Number(recovery.rows[0]?.count ?? 0)
    };
  }
}
