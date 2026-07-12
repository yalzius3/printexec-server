import { Injectable } from "@nestjs/common";
import { DatabaseService, type SqlExecutor } from "../database/database.service";
import { DEFAULT_FORMULA, evaluate, type CostingSymbols } from "./costing-formula";

// ════════════════════════════════════════════════════════════════
// OrderCostingService — the single source of truth for "what does this
// order cost, and what does it sell for".
//
// This is the LIVE recompute the Orders list/detail shows the user: each
// piece is priced from its saved cost_inputs (material grams × avg spool
// price/g, electricity, order labour split per piece, complexity, failure
// factor), falling back to the stored per-piece `cost` snapshot only when
// inputs are missing. The order base cost is the sum across pieces; the
// order total is base × (1 + profit%).
//
// Both OrdersService.attachInvoiceTotals (the displayed total) and
// FinanceService.createInvoiceFromOrder / issueInvoice (the invoice total and
// its COGS basis) go through here, so the invoice can never diverge from the
// price the customer was quoted. Do not fork this math.
// ════════════════════════════════════════════════════════════════

const FALLBACK_WATTS = 230;

// Per-order pricing tweak stored on orders.costing_config (all optional).
type OrderCostingConfig = {
  variable_ids?: string[] | null;
  custom_lines?: { label?: string | null; amount?: number | string | null }[] | null;
  margin_override_pct?: number | string | null;
};

export type OrderTotals = {
  // Pre-profit cost of the order — the COGS basis. Integer cents.
  baseCents: number;
  // base × (1 + profit%) — the sell price / invoice subtotal. Integer cents.
  totalCents: number;
  // False when no piece could be priced (no inputs and no stored cost); the
  // caller treats an unpriced order as "nothing to invoice".
  priced: boolean;
};

type PieceRow = {
  order_id: string;
  cost: string | null;
  cost_inputs: { grams?: string[]; time?: string; failure?: string } | null;
  required_filament_material: string | null;
  requires_multicolor: boolean;
  color_slots: { slot_material: string }[] | null;
};

@Injectable()
export class OrderCostingService {
  constructor(private readonly databaseService: DatabaseService) {}

  async computeTotals(
    companyId: string,
    orderId: string,
    executor?: SqlExecutor
  ): Promise<OrderTotals> {
    const map = await this.computeTotalsForOrders(companyId, [orderId], executor);
    return map.get(orderId) ?? { baseCents: 0, totalCents: 0, priced: false };
  }

  // Batch variant: one set of lookups for many orders, so an order LIST can be
  // priced without N queries. Returns a map keyed by order_id. An order with NO
  // pieces is absent from the map (the caller keeps whatever fallback it had);
  // an order whose pieces exist but none could be priced is present with
  // priced: false.
  async computeTotalsForOrders(
    companyId: string,
    orderIds: string[],
    executor?: SqlExecutor
  ): Promise<Map<string, OrderTotals>> {
    const result = new Map<string, OrderTotals>();
    if (orderIds.length === 0) return result;

    // material_type → avg price/g (priced parent spools only). Mirrors
    // AssetsService.listMaterialPricing exactly so pricing agrees app-wide.
    const matRes = await this.databaseService.query<{ material_type: string; p: string | null }>(
      `SELECT fr.material_type,
              SUM(ai.purchase_price) / NULLIF(SUM(ai.initial_grams), 0) AS p
         FROM asset_instances ai
         JOIN filament_reference fr ON fr.filament_ref_id = ai.filament_ref_id
        WHERE ai.company_id = $1
          AND ai.asset_type = 'filament_spool'
          AND ai.parent_asset_id IS NULL
          AND ai.purchase_price > 0
          AND ai.initial_grams > 0
          AND fr.material_type IS NOT NULL
        GROUP BY fr.material_type`,
      [companyId],
      executor
    );
    const matMap = new Map<string, number>();
    for (const r of matRes.rows) {
      if (r.p != null && Number.isFinite(Number(r.p))) matMap.set(r.material_type, Number(r.p));
    }

    const compRes = await this.databaseService.query<{ electricity_price_per_kwh: string | null }>(
      "SELECT electricity_price_per_kwh FROM companies WHERE company_id = $1",
      [companyId],
      executor
    );
    const rateRaw = compRes.rows[0]?.electricity_price_per_kwh;
    const elecRate = rateRaw != null && rateRaw !== "" ? Number(rateRaw) : NaN;

    // Per-order labour + profit%, and every piece's costing inputs. No status
    // filter: this matches the total the Orders UI shows (which prices all
    // pieces), so the invoice can't diverge from the quoted figure.
    const orderRes = await this.databaseService.query<{
      order_id: string;
      labor_cost: string | null;
      profit_pct: string | null;
      costing_preset_id: string | null;
      costing_config: OrderCostingConfig | null;
    }>(
      `SELECT order_id, labor_cost, profit_pct, costing_preset_id, costing_config
         FROM orders
        WHERE company_id = $1 AND order_id = ANY($2::uuid[])`,
      [companyId, orderIds],
      executor
    );
    const orderMeta = new Map(orderRes.rows.map((o) => [o.order_id, o]));

    // Extra pricing inputs (preset formulas, variable values, Finance constants)
    // are only needed when at least one order in the batch actually uses a preset.
    // A plain no-preset order stays on the legacy base × (1 + profit%) path, so a
    // normal order LIST costs no more queries than before.
    const anyPreset = orderRes.rows.some((o) => o.costing_preset_id != null);
    const presetFormulas = new Map<string, string>();
    const variableValues = new Map<string, number>();
    let defaultMarginPct = 30;
    let ordersPerMonth = 1;
    if (anyPreset) {
      const presetIds = [
        ...new Set(
          orderRes.rows.map((o) => o.costing_preset_id).filter((id): id is string => id != null)
        )
      ];
      const [presetRes, varRes, constRes] = await Promise.all([
        this.databaseService.query<{ preset_id: string; formula: string }>(
          `SELECT preset_id, formula FROM costing_presets
            WHERE company_id = $1 AND preset_id = ANY($2::uuid[])`,
          [companyId, presetIds],
          executor
        ),
        this.databaseService.query<{ costing_id: string; computed_value: string }>(
          `SELECT costing_id, computed_value::text FROM costing_variables
            WHERE company_id = $1 AND is_active = TRUE`,
          [companyId],
          executor
        ),
        this.databaseService.query<{ key: string; override_value: string | null; auto_value: string | null }>(
          `SELECT key, override_value::text, auto_value::text FROM finance_constants
            WHERE company_id = $1 AND key IN ('default_profit_margin_pct', 'avg_orders_per_month')`,
          [companyId],
          executor
        )
      ]);
      for (const r of presetRes.rows) presetFormulas.set(r.preset_id, r.formula);
      for (const r of varRes.rows) variableValues.set(r.costing_id, Number(r.computed_value) || 0);
      const byKey = new Map(constRes.rows.map((r) => [r.key, r]));
      const marginC = byKey.get("default_profit_margin_pct");
      const marginEff = marginC ? marginC.override_value ?? marginC.auto_value : null;
      if (marginEff != null && Number.isFinite(Number(marginEff))) defaultMarginPct = Number(marginEff);
      const opmC = byKey.get("avg_orders_per_month");
      const opmEff = opmC ? opmC.override_value ?? opmC.auto_value : null;
      const opmNum = opmEff != null ? Number(opmEff) : 0;
      if (Number.isFinite(opmNum) && opmNum > 0) ordersPerMonth = opmNum;
    }

    const pcRes = await this.databaseService.query<PieceRow>(
      `SELECT op.order_id, op.cost, op.cost_inputs, op.required_filament_material, op.requires_multicolor,
              (
                SELECT COALESCE(json_agg(json_build_object('slot_material', cs.slot_material) ORDER BY cs.sequence_order), '[]'::json)
                FROM order_piece_color_slots cs WHERE cs.piece_id = op.piece_id
              ) AS color_slots
         FROM order_pieces op
        WHERE op.company_id = $1 AND op.order_id = ANY($2::uuid[])`,
      [companyId, orderIds],
      executor
    );

    const piecesByOrder = new Map<string, PieceRow[]>();
    for (const p of pcRes.rows) {
      const list = piecesByOrder.get(p.order_id) ?? [];
      list.push(p);
      piecesByOrder.set(p.order_id, list);
    }

    for (const orderId of orderIds) {
      const pieces = piecesByOrder.get(orderId) ?? [];
      // No pieces: leave absent so a list caller keeps its existing fallback.
      if (pieces.length === 0) continue;
      const meta = orderMeta.get(orderId);
      const laborNum = meta?.labor_cost != null && meta.labor_cost !== "" ? Number(meta.labor_cost) : NaN;
      const laborPerPiece = Number.isFinite(laborNum) ? laborNum / Math.max(1, pieces.length) : NaN;

      // Base cost, decomposed so a formula can re-add material / electricity /
      // labour. Each component already carries its piece's complexity × failure
      // multiplier, so materialSum + elecSum + laborSum === base.
      let base = 0;
      let materialSum = 0;
      let elecSum = 0;
      let laborSum = 0;
      let anyPriced = false;
      for (const p of pieces) {
        const bd = this.pieceCostBreakdown(p, laborPerPiece, matMap, elecRate);
        if (bd != null) {
          anyPriced = true;
          base += bd.total;
          materialSum += bd.material;
          elecSum += bd.electricity;
          laborSum += bd.labor;
        }
      }
      if (!anyPriced) {
        result.set(orderId, { baseCents: 0, totalCents: 0, priced: false });
        continue;
      }

      const presetId = meta?.costing_preset_id ?? null;
      const formula = presetId != null ? presetFormulas.get(presetId) ?? DEFAULT_FORMULA : DEFAULT_FORMULA;
      const config = meta?.costing_config ?? null;

      // margin: the order's profit_pct override always wins. Otherwise a preset
      // order inherits the Finance default margin, while a legacy (no-preset)
      // order stays at 0 so it prices EXACTLY base × (1 + profit%) as before.
      const overrideRaw = meta?.profit_pct;
      const override = overrideRaw != null && overrideRaw !== "" ? Number(overrideRaw) : null;
      const marginPct =
        override != null && Number.isFinite(override)
          ? override
          : presetId != null
            ? defaultMarginPct
            : 0;

      // variables: Σ the selected costing variables' computed per-order value.
      let variablesSum = 0;
      if (config && Array.isArray(config.variable_ids)) {
        for (const id of config.variable_ids) variablesSum += variableValues.get(id) ?? 0;
      }
      // custom: Σ the order's ad-hoc custom charges.
      let customSum = 0;
      if (config && Array.isArray(config.custom_lines)) {
        for (const line of config.custom_lines) {
          const amt = Number(line?.amount);
          if (Number.isFinite(amt) && amt > 0) customSum += amt;
        }
      }

      const symbols: CostingSymbols = {
        base,
        material: materialSum,
        electricity: elecSum,
        labor: laborSum,
        variables: variablesSum,
        custom: customSum,
        margin: marginPct / 100,
        orders_per_month: ordersPerMonth
      };

      // Evaluate the preset (or the default formula). Any failure falls back to
      // the legacy figure so a bad formula can never leave an order unpriceable.
      let total: number;
      try {
        total = evaluate(formula, symbols);
      } catch {
        total = base * (1 + marginPct / 100);
      }
      if (!Number.isFinite(total) || total < 0) total = Math.max(0, base);

      result.set(orderId, {
        baseCents: Math.round(base * 100),
        totalCents: Math.round(total * 100),
        priced: true
      });
    }

    return result;
  }

  // One piece's live cost, split into its components (each already carrying that
  // piece's complexity × failure multiplier, so material + electricity + labor
  // === total), or null when the piece can't be priced. Mirrors costing.ts
  // computePieceCostBreakdown() on the client — keep the two in step. Pieces with
  // no cost_inputs fall back to their stored `cost` snapshot, attributed wholly to
  // `total` (no component split is recoverable for those legacy rows).
  private pieceCostBreakdown(
    p: PieceRow,
    laborPerPiece: number,
    matMap: Map<string, number>,
    elecRate: number
  ): { material: number; electricity: number; labor: number; total: number } | null {
    const ci = p.cost_inputs;
    if (ci) {
      const minutes = Number(ci.time);
      if (Number.isFinite(minutes) && minutes > 0) {
        const grams = (ci.grams ?? []).map((g) => Number(g) || 0);
        let material = 0;
        let totalGrams = 0;
        for (let j = 0; j < grams.length; j += 1) {
          const g = grams[j] || 0;
          if (g <= 0) continue;
          totalGrams += g;
          const mat = p.requires_multicolor && p.color_slots?.[j]
            ? p.color_slots[j]!.slot_material
            : p.required_filament_material ?? undefined;
          const price = mat ? matMap.get(mat) : undefined;
          if (price != null) material += price * g;
        }
        if (totalGrams > 0) {
          const electricity = Number.isFinite(elecRate)
            ? ((FALLBACK_WATTS * minutes) / 60 / 1000) * elecRate
            : 0;
          const labor = Number.isFinite(laborPerPiece) ? laborPerPiece : 0;
          const complexity = Math.max(1, minutes / totalGrams);
          const failPct = Number(ci.failure);
          const failFactor = 1 + (Number.isFinite(failPct) ? failPct : 0) / 100;
          const m = material * complexity * failFactor;
          const e = electricity * complexity * failFactor;
          const l = labor * complexity * failFactor;
          return { material: m, electricity: e, labor: l, total: m + e + l };
        }
      }
    }
    const stored = p.cost != null && p.cost !== "" ? Number(p.cost) : null;
    if (stored != null && Number.isFinite(stored)) {
      return { material: 0, electricity: 0, labor: 0, total: stored };
    }
    return null;
  }
}
