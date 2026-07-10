import { Injectable } from "@nestjs/common";
import { DatabaseService, type SqlExecutor } from "../database/database.service";

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
    }>(
      `SELECT order_id, labor_cost, profit_pct
         FROM orders
        WHERE company_id = $1 AND order_id = ANY($2::uuid[])`,
      [companyId, orderIds],
      executor
    );
    const orderMeta = new Map(orderRes.rows.map((o) => [o.order_id, o]));

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

      let base = 0;
      let anyPriced = false;
      for (const p of pieces) {
        const c = this.pieceCost(p, laborPerPiece, matMap, elecRate);
        if (c != null) {
          anyPriced = true;
          base += c;
        }
      }
      if (!anyPriced) {
        result.set(orderId, { baseCents: 0, totalCents: 0, priced: false });
        continue;
      }
      const profit = meta?.profit_pct != null && meta.profit_pct !== "" ? Number(meta.profit_pct) : 0;
      const total = base * (1 + (Number.isFinite(profit) ? profit : 0) / 100);
      result.set(orderId, {
        baseCents: Math.round(base * 100),
        totalCents: Math.round(total * 100),
        priced: true
      });
    }

    return result;
  }

  // One piece's live cost, or null when it can't be priced. Mirrors
  // costing.ts computePieceCost() on the client and the fallback to a stored
  // snapshot — keep the three in step.
  private pieceCost(
    p: PieceRow,
    laborPerPiece: number,
    matMap: Map<string, number>,
    elecRate: number
  ): number | null {
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
          const complexity = totalGrams / minutes + 1;
          const failPct = Number(ci.failure);
          const failFactor = 1 + (Number.isFinite(failPct) ? failPct : 0) / 100;
          return (material + electricity + labor) * complexity * failFactor;
        }
      }
    }
    const stored = p.cost != null && p.cost !== "" ? Number(p.cost) : null;
    return stored != null && Number.isFinite(stored) ? stored : null;
  }
}
