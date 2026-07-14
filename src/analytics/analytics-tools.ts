import type { ZodType } from "zod";
import type { DatabaseService } from "../database/database.service";
import {
  emptyParamsSchema,
  limitedPeriodParamsSchema,
  periodParamsSchema,
  runwayParamsSchema,
  seriesParamsSchema
} from "./analytics.schemas";

// ════════════════════════════════════════════════════════════════
// Analytics tool registry — the ONE list of preset, tenant-scoped, read-only
// queries behind the dashboard.
//
// Every tool here is exposed twice, from the same definition:
//   · REST — GET /analytics/t/:name (each dashboard card calls its tool)
//   · AI   — the tool belt handed to the model by AnalyticsAiService
// so an AI answer can never disagree with what the dashboard shows.
//
// Rules of the registry:
//   · The model NEVER writes SQL. It picks a tool + params; zod validates;
//     company_id is bound server-side ($1) and never appears in params.
//   · Read-only rollups only — same discipline as FinanceReportsService.
//   · NUMERIC money comes back ::text (pg returns it as string); the client
//     renders, never re-derives. Ratios/hours are ::float8 for charting.
//   · `financial: true` tools carry money and require view_finance;
//     the rest require view_dashboard (owners bypass both, PermissionGuard
//     style).
//
// Revenue basis: issued invoices (status NOT IN draft/void) — the accounting
// truth. Orders carry no stored total (pricing = mirrored costing formula), so
// order-value analytics deliberately read the billed documents instead of
// re-evaluating formulas in SQL.
// ════════════════════════════════════════════════════════════════

export interface ToolResultShape {
  [key: string]: unknown;
}

export interface AnalyticsTool {
  name: string;
  title: string;
  /** AI-facing description: what it answers + what the fields mean. */
  description: string;
  /** true → requires view_finance; false → requires view_dashboard. */
  financial: boolean;
  params: ZodType;
  /** Hand-written JSON Schema for the AI tool belt (kept dependency-free). */
  jsonSchema: Record<string, unknown>;
  run(db: DatabaseService, companyId: string, params: Record<string, unknown>): Promise<ToolResultShape>;
}

// ── Period helpers ──────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Resolve from/to with defaults (last 30 days) + the same-length window
 *  immediately before it, for Δ-vs-previous readouts. */
export function resolvePeriod(params: { from?: string; to?: string }) {
  const to = params.to ?? iso(new Date());
  const from = params.from ?? iso(new Date(new Date(`${to}T00:00:00Z`).getTime() - 29 * DAY_MS));
  const spanDays = Math.max(1, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1);
  const prevTo = iso(new Date(Date.parse(`${from}T00:00:00Z`) - DAY_MS));
  const prevFrom = iso(new Date(Date.parse(`${prevTo}T00:00:00Z`) - (spanDays - 1) * DAY_MS));
  return { from, to, prevFrom, prevTo, spanDays };
}

function resolveGranularity(spanDays: number, requested?: string): "day" | "week" | "month" {
  if (requested === "day" || requested === "week" || requested === "month") return requested;
  if (spanDays <= 35) return "day";
  if (spanDays <= 140) return "week";
  return "month";
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;

// ── JSON Schema fragments (mirror the zod schemas above) ────────────────────

const dateProp = (what: string) => ({
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}$",
  description: `${what} (YYYY-MM-DD). Defaults to a 30-day window ending today.`
});

const periodJsonSchema = {
  type: "object",
  properties: { from: dateProp("Start date"), to: dateProp("End date") },
  additionalProperties: false
};

const seriesJsonSchema = {
  type: "object",
  properties: {
    from: dateProp("Start date"),
    to: dateProp("End date"),
    granularity: {
      type: "string",
      enum: ["auto", "day", "week", "month"],
      description: "Bucket size; 'auto' picks day/week/month from the span."
    }
  },
  additionalProperties: false
};

const limitedJsonSchema = {
  type: "object",
  properties: {
    from: dateProp("Start date"),
    to: dateProp("End date"),
    limit: { type: "integer", minimum: 1, maximum: 25, description: "Max rows (default 8)." }
  },
  additionalProperties: false
};

const emptyJsonSchema = { type: "object", properties: {}, additionalProperties: false };

// ── Shared SQL fragments ────────────────────────────────────────────────────

/** Issued (billable) invoices only. */
const INV = `invoices i` ;
const INV_ISSUED = `i.company_id = $1 AND i.status NOT IN ('draft', 'void')`;

/** Overlap of a piece's scheduled window with [from, to] in hours. */
const OVERLAP_HOURS = (fromP: string, toP: string) => `
  EXTRACT(EPOCH FROM (
    LEAST(op.scheduled_end_at, (${toP}::date + 1)::timestamptz)
    - GREATEST(op.scheduled_start_at, ${fromP}::date::timestamptz)
  )) / 3600.0`;

// ════════════════════════════════════════════════════════════════
// The registry
// ════════════════════════════════════════════════════════════════

export const ANALYTICS_TOOLS: AnalyticsTool[] = [
  // ── Joint spine ───────────────────────────────────────────────────────────
  {
    name: "kpi_summary",
    title: "KPI summary",
    description:
      "Headline numbers for a period WITH the previous same-length period for comparison: billed revenue, invoice count, average order value (AOV), orders created/fulfilled, fleet booked print-hours + utilization %, waste cost/grams, open receivables, and posted-ledger revenue/COGS/waste (gross margin). Call this first for any overview question.",
    financial: true,
    params: periodParamsSchema,
    jsonSchema: periodJsonSchema,
    async run(db, companyId, params) {
      const p = resolvePeriod(params as { from?: string; to?: string });
      const { rows } = await db.query<Record<string, string | number | null>>(
        `
          SELECT
            (SELECT COALESCE(SUM(i.total), 0) FROM ${INV} WHERE ${INV_ISSUED} AND i.issue_date BETWEEN $2::date AND $3::date)::text AS revenue,
            (SELECT COALESCE(SUM(i.total), 0) FROM ${INV} WHERE ${INV_ISSUED} AND i.issue_date BETWEEN $4::date AND $5::date)::text AS revenue_prev,
            (SELECT COUNT(*) FROM ${INV} WHERE ${INV_ISSUED} AND i.issue_date BETWEEN $2::date AND $3::date)::int AS invoice_count,
            (SELECT COUNT(*) FROM ${INV} WHERE ${INV_ISSUED} AND i.issue_date BETWEEN $4::date AND $5::date)::int AS invoice_count_prev,
            (SELECT COALESCE(AVG(i.total), 0) FROM ${INV} WHERE ${INV_ISSUED} AND i.issue_date BETWEEN $2::date AND $3::date)::text AS aov,
            (SELECT COALESCE(AVG(i.total), 0) FROM ${INV} WHERE ${INV_ISSUED} AND i.issue_date BETWEEN $4::date AND $5::date)::text AS aov_prev,
            (SELECT COUNT(*) FROM orders o WHERE o.company_id = $1 AND o.created_at >= $2::date AND o.created_at < ($3::date + 1))::int AS orders_created,
            (SELECT COUNT(*) FROM orders o WHERE o.company_id = $1 AND o.created_at >= $4::date AND o.created_at < ($5::date + 1))::int AS orders_created_prev,
            (SELECT COUNT(*) FROM orders o WHERE o.company_id = $1 AND o.fulfilled_at >= $2::date AND o.fulfilled_at < ($3::date + 1))::int AS orders_fulfilled,
            (SELECT COUNT(*) FROM orders o WHERE o.company_id = $1 AND o.fulfilled_at >= $4::date AND o.fulfilled_at < ($5::date + 1))::int AS orders_fulfilled_prev,
            (SELECT COUNT(*) FROM printer_instances pi WHERE pi.company_id = $1)::int AS printer_count,
            (SELECT COALESCE(SUM(${OVERLAP_HOURS("$2", "$3")}), 0)
               FROM order_pieces op
              WHERE op.company_id = $1
                AND op.scheduled_start_at < ($3::date + 1)::timestamptz
                AND op.scheduled_end_at > $2::date::timestamptz)::float8 AS booked_hours,
            (SELECT COALESCE(SUM(fw.cost), 0) FROM filament_waste_events fw WHERE fw.company_id = $1 AND fw.created_at >= $2::date AND fw.created_at < ($3::date + 1))::text AS waste_cost,
            (SELECT COALESCE(SUM(fw.cost), 0) FROM filament_waste_events fw WHERE fw.company_id = $1 AND fw.created_at >= $4::date AND fw.created_at < ($5::date + 1))::text AS waste_cost_prev,
            (SELECT COALESCE(SUM(fw.grams), 0) FROM filament_waste_events fw WHERE fw.company_id = $1 AND fw.created_at >= $2::date AND fw.created_at < ($3::date + 1))::text AS waste_grams,
            (SELECT COALESCE(SUM(i.balance_due), 0) FROM ${INV} WHERE i.company_id = $1 AND i.status IN ('open', 'partial'))::text AS ar_open_balance,
            (SELECT COALESCE(SUM(l.credit - l.debit), 0)
               FROM journal_lines l
               JOIN journal_entries e ON e.entry_id = l.entry_id
               JOIN finance_accounts a ON a.account_id = l.account_id
              WHERE l.company_id = $1 AND e.status = 'posted' AND e.entry_date BETWEEN $2::date AND $3::date
                AND a.account_type = 'revenue')::text AS ledger_revenue,
            (SELECT COALESCE(SUM(l.debit - l.credit), 0)
               FROM journal_lines l
               JOIN journal_entries e ON e.entry_id = l.entry_id
               JOIN finance_accounts a ON a.account_id = l.account_id
              WHERE l.company_id = $1 AND e.status = 'posted' AND e.entry_date BETWEEN $2::date AND $3::date
                AND COALESCE(a.account_subtype, '') = 'cogs')::text AS ledger_cogs,
            (SELECT COALESCE(SUM(l.debit - l.credit), 0)
               FROM journal_lines l
               JOIN journal_entries e ON e.entry_id = l.entry_id
               JOIN finance_accounts a ON a.account_id = l.account_id
              WHERE l.company_id = $1 AND e.status = 'posted' AND e.entry_date BETWEEN $2::date AND $3::date
                AND COALESCE(a.account_subtype, '') = 'filament_waste')::text AS ledger_waste
        `,
        [companyId, p.from, p.to, p.prevFrom, p.prevTo]
      );
      const r = rows[0] ?? {};
      const booked = num(r.booked_hours);
      const capacity = num(r.printer_count) * p.spanDays * 24;
      const ledgerRev = num(r.ledger_revenue);
      const grossMargin = ledgerRev > 0 ? ((ledgerRev - num(r.ledger_cogs) - num(r.ledger_waste)) / ledgerRev) * 100 : null;
      return {
        period: { from: p.from, to: p.to, prev_from: p.prevFrom, prev_to: p.prevTo, days: p.spanDays },
        ...r,
        booked_hours: round1(booked),
        capacity_hours: capacity,
        utilization_pct: capacity > 0 ? round1((booked / capacity) * 100) : null,
        gross_margin_pct: grossMargin === null ? null : round1(grossMargin)
      };
    }
  },

  // ── Financial ─────────────────────────────────────────────────────────────
  {
    name: "revenue_timeseries",
    title: "Revenue over time",
    description:
      "Billed revenue (issued invoice totals) bucketed by day/week/month over a period, INCLUDING empty buckets, plus a least-squares regression over the individual invoices: slope_per_day (currency/day), r2, and mean invoice value. Use for growth/trend questions.",
    financial: true,
    params: seriesParamsSchema,
    jsonSchema: seriesJsonSchema,
    async run(db, companyId, params) {
      const p = resolvePeriod(params as { from?: string; to?: string });
      const g = resolveGranularity(p.spanDays, (params as { granularity?: string }).granularity);
      const [series, reg] = await Promise.all([
        db.query<{ t: string; value: string; count: number }>(
          `
            WITH buckets AS (
              SELECT generate_series(date_trunc($4, $2::date), date_trunc($4, $3::date), ('1 ' || $4)::interval)::date AS t
            ),
            agg AS (
              SELECT date_trunc($4, i.issue_date)::date AS t, SUM(i.total) AS value, COUNT(*) AS n
              FROM ${INV}
              WHERE ${INV_ISSUED} AND i.issue_date BETWEEN $2::date AND $3::date
              GROUP BY 1
            )
            SELECT b.t::text AS t, COALESCE(a.value, 0)::text AS value, COALESCE(a.n, 0)::int AS count
            FROM buckets b LEFT JOIN agg a ON a.t = b.t
            ORDER BY b.t
          `,
          [companyId, p.from, p.to, g]
        ),
        db.query<{ slope_per_day: number | null; r2: number | null; mean: string | null; n: number }>(
          `
            SELECT regr_slope(i.total, EXTRACT(EPOCH FROM i.issue_date::timestamp) / 86400.0)::float8 AS slope_per_day,
                   regr_r2(i.total, EXTRACT(EPOCH FROM i.issue_date::timestamp) / 86400.0)::float8 AS r2,
                   AVG(i.total)::text AS mean,
                   COUNT(*)::int AS n
            FROM ${INV}
            WHERE ${INV_ISSUED} AND i.issue_date BETWEEN $2::date AND $3::date
          `,
          [companyId, p.from, p.to]
        )
      ]);
      const rr = reg.rows[0];
      return {
        period: { from: p.from, to: p.to },
        granularity: g,
        buckets: series.rows,
        regression: {
          slope_per_day: rr?.slope_per_day ?? null,
          r2: rr?.r2 ?? null,
          mean: rr?.mean ?? "0",
          points: rr?.n ?? 0
        }
      };
    }
  },
  {
    name: "aov_timeseries",
    title: "Average order value over time",
    description:
      "Average issued-invoice value (AOV) per day/week/month bucket over a period, plus regression over individual invoices (slope_per_day = how fast order value grows per day, r2 = fit quality). THE tool for 'is our order value growing' questions.",
    financial: true,
    params: seriesParamsSchema,
    jsonSchema: seriesJsonSchema,
    async run(db, companyId, params) {
      const p = resolvePeriod(params as { from?: string; to?: string });
      const g = resolveGranularity(p.spanDays, (params as { granularity?: string }).granularity);
      const [series, reg] = await Promise.all([
        db.query<{ t: string; value: string | null; count: number }>(
          `
            WITH buckets AS (
              SELECT generate_series(date_trunc($4, $2::date), date_trunc($4, $3::date), ('1 ' || $4)::interval)::date AS t
            ),
            agg AS (
              SELECT date_trunc($4, i.issue_date)::date AS t, AVG(i.total) AS value, COUNT(*) AS n
              FROM ${INV}
              WHERE ${INV_ISSUED} AND i.issue_date BETWEEN $2::date AND $3::date
              GROUP BY 1
            )
            SELECT b.t::text AS t, a.value::text AS value, COALESCE(a.n, 0)::int AS count
            FROM buckets b LEFT JOIN agg a ON a.t = b.t
            ORDER BY b.t
          `,
          [companyId, p.from, p.to, g]
        ),
        db.query<{ slope_per_day: number | null; r2: number | null; mean: string | null; n: number }>(
          `
            SELECT regr_slope(i.total, EXTRACT(EPOCH FROM i.issue_date::timestamp) / 86400.0)::float8 AS slope_per_day,
                   regr_r2(i.total, EXTRACT(EPOCH FROM i.issue_date::timestamp) / 86400.0)::float8 AS r2,
                   AVG(i.total)::text AS mean,
                   COUNT(*)::int AS n
            FROM ${INV}
            WHERE ${INV_ISSUED} AND i.issue_date BETWEEN $2::date AND $3::date
          `,
          [companyId, p.from, p.to]
        )
      ]);
      const rr = reg.rows[0];
      return {
        period: { from: p.from, to: p.to },
        granularity: g,
        buckets: series.rows,
        regression: {
          slope_per_day: rr?.slope_per_day ?? null,
          r2: rr?.r2 ?? null,
          mean: rr?.mean ?? "0",
          points: rr?.n ?? 0
        }
      };
    }
  },
  {
    name: "top_customers",
    title: "Top customers",
    description:
      "Customers ranked by billed revenue in a period: revenue, invoice count, AOV, and share_pct of period revenue. Includes invoices without a CRM link under their counterparty name. Use for concentration/'who drives revenue' questions.",
    financial: true,
    params: limitedPeriodParamsSchema,
    jsonSchema: limitedJsonSchema,
    async run(db, companyId, params) {
      const p = resolvePeriod(params as { from?: string; to?: string });
      const limit = (params as { limit?: number }).limit ?? 8;
      const { rows } = await db.query<{
        customer_id: string | null;
        name: string;
        revenue: string;
        invoices: number;
        aov: string;
        grand: string;
      }>(
        `
          SELECT c.customer_id,
                 COALESCE(
                   CASE WHEN c.customer_type = 'b2b' THEN NULLIF(c.business_name, '') END,
                   NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), ''),
                   NULLIF(i.counterparty_name, ''),
                   'Unknown'
                 ) AS name,
                 SUM(i.total)::text AS revenue,
                 COUNT(*)::int AS invoices,
                 AVG(i.total)::text AS aov,
                 SUM(SUM(i.total)) OVER ()::text AS grand
          FROM ${INV}
          LEFT JOIN customers c ON c.customer_id = i.customer_id
          WHERE ${INV_ISSUED} AND i.issue_date BETWEEN $2::date AND $3::date
          GROUP BY c.customer_id, 2
          ORDER BY SUM(i.total) DESC
          LIMIT $4
        `,
        [companyId, p.from, p.to, limit]
      );
      const grand = num(rows[0]?.grand);
      return {
        period: { from: p.from, to: p.to },
        rows: rows.map(({ grand: _g, ...r }) => ({
          ...r,
          share_pct: grand > 0 ? round1((num(r.revenue) / grand) * 100) : null
        }))
      };
    }
  },
  {
    name: "ar_aging",
    title: "Receivables aging",
    description:
      "Open + partially-paid invoice balances bucketed by how overdue they are (current, 1-30, 31-60, 61-90, 90+ days past due). Snapshot of money owed right now — no period parameters.",
    financial: true,
    params: emptyParamsSchema,
    jsonSchema: emptyJsonSchema,
    async run(db, companyId) {
      const { rows } = await db.query<{ bucket: string; n: number; balance: string }>(
        `
          SELECT CASE
                   WHEN i.due_date IS NULL OR i.due_date >= CURRENT_DATE THEN 'current'
                   WHEN CURRENT_DATE - i.due_date <= 30 THEN '1-30'
                   WHEN CURRENT_DATE - i.due_date <= 60 THEN '31-60'
                   WHEN CURRENT_DATE - i.due_date <= 90 THEN '61-90'
                   ELSE '90+'
                 END AS bucket,
                 COUNT(*)::int AS n,
                 SUM(i.balance_due)::text AS balance
          FROM ${INV}
          WHERE i.company_id = $1 AND i.status IN ('open', 'partial') AND i.balance_due > 0
          GROUP BY 1
        `,
        [companyId]
      );
      const order = ["current", "1-30", "31-60", "61-90", "90+"];
      return {
        buckets: order.map((b) => rows.find((r) => r.bucket === b) ?? { bucket: b, n: 0, balance: "0" })
      };
    }
  },
  {
    name: "expense_breakdown",
    title: "Expense breakdown",
    description:
      "Posted-ledger expense activity by account (code, name, amount) over a period, largest first — where the money actually went, including COGS (5000) and Filament Waste (5100).",
    financial: true,
    params: periodParamsSchema,
    jsonSchema: periodJsonSchema,
    async run(db, companyId, params) {
      const p = resolvePeriod(params as { from?: string; to?: string });
      const { rows } = await db.query<{ code: string; name: string; amount: string }>(
        `
          SELECT a.code, a.name, SUM(l.debit - l.credit)::text AS amount
          FROM journal_lines l
          JOIN journal_entries e ON e.entry_id = l.entry_id
          JOIN finance_accounts a ON a.account_id = l.account_id
          WHERE l.company_id = $1 AND e.status = 'posted' AND a.account_type = 'expense'
            AND e.entry_date BETWEEN $2::date AND $3::date
          GROUP BY a.account_id, a.code, a.name
          HAVING SUM(l.debit - l.credit) <> 0
          ORDER BY SUM(l.debit - l.credit) DESC
          LIMIT 25
        `,
        [companyId, p.from, p.to]
      );
      return { period: { from: p.from, to: p.to }, rows };
    }
  },
  {
    name: "pnl_summary",
    title: "P&L summary",
    description:
      "Posted-ledger profit & loss for a period, shaped for a card: revenue, COGS, filament waste, other expenses, and net income. Accounting truth (posted entries only).",
    financial: true,
    params: periodParamsSchema,
    jsonSchema: periodJsonSchema,
    async run(db, companyId, params) {
      const p = resolvePeriod(params as { from?: string; to?: string });
      const { rows } = await db.query<{ revenue: string; cogs: string; waste: string; other_expense: string }>(
        `
          SELECT
            COALESCE(SUM(CASE WHEN a.account_type = 'revenue' THEN l.credit - l.debit END), 0)::text AS revenue,
            COALESCE(SUM(CASE WHEN COALESCE(a.account_subtype, '') = 'cogs' THEN l.debit - l.credit END), 0)::text AS cogs,
            COALESCE(SUM(CASE WHEN COALESCE(a.account_subtype, '') = 'filament_waste' THEN l.debit - l.credit END), 0)::text AS waste,
            COALESCE(SUM(CASE WHEN a.account_type = 'expense'
                               AND COALESCE(a.account_subtype, '') NOT IN ('cogs', 'filament_waste')
                              THEN l.debit - l.credit END), 0)::text AS other_expense
          FROM journal_lines l
          JOIN journal_entries e ON e.entry_id = l.entry_id
          JOIN finance_accounts a ON a.account_id = l.account_id
          WHERE l.company_id = $1 AND e.status = 'posted' AND e.entry_date BETWEEN $2::date AND $3::date
        `,
        [companyId, p.from, p.to]
      );
      const r = rows[0] ?? { revenue: "0", cogs: "0", waste: "0", other_expense: "0" };
      const net = num(r.revenue) - num(r.cogs) - num(r.waste) - num(r.other_expense);
      return { period: { from: p.from, to: p.to }, ...r, net_income: round2(net).toFixed(2) };
    }
  },
  {
    name: "order_status_funnel",
    title: "Order pipeline",
    description:
      "Current snapshot of ALL orders by status (draft → confirmed → in_progress → completed → ready_for_shipping → out_for_shipping → fulfilled, plus returned/cancelled) with order counts and the issued-invoice value attached to each stage.",
    financial: true,
    params: emptyParamsSchema,
    jsonSchema: emptyJsonSchema,
    async run(db, companyId) {
      const { rows } = await db.query<{ status: string; orders: number; invoiced_value: string }>(
        `
          SELECT o.status,
                 COUNT(*)::int AS orders,
                 COALESCE(SUM(inv.value), 0)::text AS invoiced_value
          FROM orders o
          LEFT JOIN LATERAL (
            SELECT SUM(i.total) AS value
            FROM invoices i
            WHERE i.order_id = o.order_id AND i.company_id = $1 AND i.status NOT IN ('draft', 'void')
          ) inv ON TRUE
          WHERE o.company_id = $1
          GROUP BY o.status
        `,
        [companyId]
      );
      const order = [
        "draft", "confirmed", "in_progress", "completed",
        "ready_for_shipping", "out_for_shipping", "fulfilled", "returned", "cancelled"
      ];
      return {
        stages: order
          .map((s) => rows.find((r) => r.status === s) ?? { status: s, orders: 0, invoiced_value: "0" })
      };
    }
  },

  // ── Production ────────────────────────────────────────────────────────────
  {
    name: "printer_utilization",
    title: "Printer utilization",
    description:
      "Per-printer leaderboard for a period: booked print-hours (scheduled windows overlapping the period), utilization_pct of 24h capacity, pieces completed, failed-print waste events + grams. Use for 'which machines earn/idle/fail' questions.",
    financial: false,
    params: periodParamsSchema,
    jsonSchema: periodJsonSchema,
    async run(db, companyId, params) {
      const p = resolvePeriod(params as { from?: string; to?: string });
      const { rows } = await db.query<{
        printer_id: string;
        label: string | null;
        booked_hours: number;
        pieces_done: number;
        waste_events: number;
        waste_grams: number;
      }>(
        `
          SELECT pi.printer_id,
                 NULLIF(TRIM(CONCAT_WS(' ', pi.brand, pi.model)), '') AS label,
                 COALESCE(bh.hours, 0)::float8 AS booked_hours,
                 COALESCE(pc.n, 0)::int AS pieces_done,
                 COALESCE(w.events, 0)::int AS waste_events,
                 COALESCE(w.grams, 0)::float8 AS waste_grams
          FROM printer_instances pi
          LEFT JOIN LATERAL (
            SELECT SUM(${OVERLAP_HOURS("$2", "$3")}) AS hours
            FROM order_pieces op
            WHERE op.company_id = $1 AND op.assigned_printer_id = pi.printer_id
              AND op.scheduled_start_at < ($3::date + 1)::timestamptz
              AND op.scheduled_end_at > $2::date::timestamptz
          ) bh ON TRUE
          LEFT JOIN LATERAL (
            SELECT COUNT(*) AS n
            FROM order_pieces op
            WHERE op.company_id = $1 AND op.assigned_printer_id = pi.printer_id
              AND op.print_completed_at >= $2::date AND op.print_completed_at < ($3::date + 1)
          ) pc ON TRUE
          LEFT JOIN LATERAL (
            SELECT COUNT(*) AS events, SUM(fw.grams) AS grams
            FROM filament_waste_events fw
            JOIN order_pieces op2 ON op2.piece_id = fw.piece_id
            WHERE fw.company_id = $1 AND op2.assigned_printer_id = pi.printer_id
              AND fw.created_at >= $2::date AND fw.created_at < ($3::date + 1)
          ) w ON TRUE
          WHERE pi.company_id = $1
          ORDER BY COALESCE(bh.hours, 0) DESC
          LIMIT 50
        `,
        [companyId, p.from, p.to]
      );
      const capacityPerPrinter = p.spanDays * 24;
      return {
        period: { from: p.from, to: p.to },
        rows: rows.map((r) => ({
          ...r,
          booked_hours: round1(num(r.booked_hours)),
          waste_grams: round1(num(r.waste_grams)),
          utilization_pct: capacityPerPrinter > 0 ? round1((num(r.booked_hours) / capacityPerPrinter) * 100) : null
        }))
      };
    }
  },
  {
    name: "throughput_timeseries",
    title: "Throughput over time",
    description:
      "Completed pieces per day/week/month bucket, with printed hours (slicer estimates of the completed pieces) and grams consumed. Empty buckets included. Use for 'how much are we producing' questions.",
    financial: false,
    params: seriesParamsSchema,
    jsonSchema: seriesJsonSchema,
    async run(db, companyId, params) {
      const p = resolvePeriod(params as { from?: string; to?: string });
      const g = resolveGranularity(p.spanDays, (params as { granularity?: string }).granularity);
      const { rows } = await db.query<{ t: string; pieces: number; hours: number; grams: number }>(
        `
          WITH buckets AS (
            SELECT generate_series(date_trunc($4, $2::date), date_trunc($4, $3::date), ('1 ' || $4)::interval)::date AS t
          ),
          agg AS (
            SELECT date_trunc($4, op.print_completed_at)::date AS t,
                   COUNT(*) AS pieces,
                   COALESCE(SUM(op.slicer_print_time_minutes), 0) / 60.0 AS hours,
                   COALESCE(SUM(op.slicer_filament_used_grams), 0) AS grams
            FROM order_pieces op
            WHERE op.company_id = $1
              AND op.print_completed_at >= $2::date AND op.print_completed_at < ($3::date + 1)
            GROUP BY 1
          )
          SELECT b.t::text AS t,
                 COALESCE(a.pieces, 0)::int AS pieces,
                 COALESCE(a.hours, 0)::float8 AS hours,
                 COALESCE(a.grams, 0)::float8 AS grams
          FROM buckets b LEFT JOIN agg a ON a.t = b.t
          ORDER BY b.t
        `,
        [companyId, p.from, p.to, g]
      );
      return {
        period: { from: p.from, to: p.to },
        granularity: g,
        buckets: rows.map((r) => ({ ...r, hours: round1(num(r.hours)), grams: Math.round(num(r.grams)) }))
      };
    }
  },
  {
    name: "queue_backlog",
    title: "Queue backlog",
    description:
      "Now-snapshot of unprinted work on active orders: pieces printing right now, scheduled (future window) and unscheduled counts + slicer-estimated hours, the fleet's realized print-hours/day over the last 14 days, and est_clear_days = backlog ÷ that realized rate.",
    financial: false,
    params: emptyParamsSchema,
    jsonSchema: emptyJsonSchema,
    async run(db, companyId) {
      const { rows } = await db.query<{
        printing_now: number;
        scheduled_pieces: number;
        scheduled_hours: number;
        unscheduled_pieces: number;
        unscheduled_hours: number;
        recent_hours_per_day: number;
      }>(
        `
          SELECT
            COUNT(*) FILTER (
              WHERE op.status = 'printing'
                 OR (op.scheduled_start_at <= now() AND op.scheduled_end_at > now())
            )::int AS printing_now,
            COUNT(*) FILTER (WHERE op.scheduled_start_at > now())::int AS scheduled_pieces,
            (COALESCE(SUM(op.slicer_print_time_minutes) FILTER (WHERE op.scheduled_start_at > now()), 0) / 60.0)::float8 AS scheduled_hours,
            COUNT(*) FILTER (WHERE op.scheduled_start_at IS NULL)::int AS unscheduled_pieces,
            (COALESCE(SUM(op.slicer_print_time_minutes) FILTER (WHERE op.scheduled_start_at IS NULL), 0) / 60.0)::float8 AS unscheduled_hours,
            (SELECT (COALESCE(SUM(op2.slicer_print_time_minutes), 0) / 60.0 / 14.0)::float8
               FROM order_pieces op2
              WHERE op2.company_id = $1 AND op2.print_completed_at >= now() - interval '14 days') AS recent_hours_per_day
          FROM order_pieces op
          JOIN orders o ON o.order_id = op.order_id
          WHERE op.company_id = $1
            AND op.print_completed_at IS NULL
            AND op.status <> 'done'
            AND o.status IN ('confirmed', 'in_progress')
        `,
        [companyId]
      );
      const r = rows[0];
      const backlogHours = num(r?.scheduled_hours) + num(r?.unscheduled_hours);
      const rate = num(r?.recent_hours_per_day);
      return {
        printing_now: r?.printing_now ?? 0,
        scheduled_pieces: r?.scheduled_pieces ?? 0,
        scheduled_hours: round1(num(r?.scheduled_hours)),
        unscheduled_pieces: r?.unscheduled_pieces ?? 0,
        unscheduled_hours: round1(num(r?.unscheduled_hours)),
        backlog_hours: round1(backlogHours),
        recent_hours_per_day: round1(rate),
        est_clear_days: rate > 0 ? round1(backlogHours / rate) : null
      };
    }
  },
  {
    name: "lead_time",
    title: "Order lead time",
    description:
      "For orders FULFILLED in the period: count, average, median (p50) and p90 days from order creation to fulfilment. Use for 'how fast do we deliver' questions.",
    financial: false,
    params: periodParamsSchema,
    jsonSchema: periodJsonSchema,
    async run(db, companyId, params) {
      const p = resolvePeriod(params as { from?: string; to?: string });
      const { rows } = await db.query<{ n: number; avg_days: number | null; p50: number | null; p90: number | null }>(
        `
          SELECT COUNT(*)::int AS n,
                 AVG(EXTRACT(EPOCH FROM (o.fulfilled_at - o.created_at)) / 86400.0)::float8 AS avg_days,
                 (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (o.fulfilled_at - o.created_at)) / 86400.0))::float8 AS p50,
                 (PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (o.fulfilled_at - o.created_at)) / 86400.0))::float8 AS p90
          FROM orders o
          WHERE o.company_id = $1
            AND o.fulfilled_at IS NOT NULL
            AND o.fulfilled_at >= $2::date AND o.fulfilled_at < ($3::date + 1)
        `,
        [companyId, p.from, p.to]
      );
      const r = rows[0];
      return {
        period: { from: p.from, to: p.to },
        fulfilled_orders: r?.n ?? 0,
        avg_days: r?.avg_days === null || r?.avg_days === undefined ? null : round1(num(r.avg_days)),
        p50_days: r?.p50 === null || r?.p50 === undefined ? null : round1(num(r.p50)),
        p90_days: r?.p90 === null || r?.p90 === undefined ? null : round1(num(r.p90))
      };
    }
  },
  {
    name: "filament_runway",
    title: "Filament runway",
    description:
      "Per material: grams remaining across live spools, spool count, burn rate g/day over the last 30 days (completed-piece slicer grams + waste — multicolor pieces approximated to their primary material), and days_left. Sorted soonest-out first; days_left null means no recent burn. Optional threshold_days marks materials as low.",
    financial: false,
    params: runwayParamsSchema,
    jsonSchema: {
      type: "object",
      properties: {
        threshold_days: {
          type: "integer",
          minimum: 1,
          maximum: 365,
          description: "Materials with days_left at or below this are flagged low (default 14)."
        }
      },
      additionalProperties: false
    },
    async run(db, companyId, params) {
      const threshold = (params as { threshold_days?: number }).threshold_days ?? 14;
      const { rows } = await db.query<{
        material: string;
        remaining_grams: number;
        spool_count: number;
        burn_g_per_day: number;
      }>(
        `
          WITH stock AS (
            SELECT COALESCE(fr.material_type, 'Unknown') AS material,
                   SUM(COALESCE(ast.remaining_grams, ai.initial_grams, 0))::float8 AS remaining_grams,
                   COUNT(*)::int AS spool_count
            FROM asset_instances ai
            LEFT JOIN asset_stock ast ON ast.asset_id = ai.asset_id
            LEFT JOIN filament_reference fr ON fr.filament_ref_id = ai.filament_ref_id
            WHERE ai.company_id = $1 AND ai.asset_type = 'filament_spool'
              AND COALESCE(ast.remaining_grams, ai.initial_grams, 0) > 0
            GROUP BY 1
          ),
          burn AS (
            SELECT COALESCE(op.required_filament_material, 'Unknown') AS material,
                   SUM(COALESCE(op.slicer_filament_used_grams, 0))::float8 AS g
            FROM order_pieces op
            WHERE op.company_id = $1 AND op.print_completed_at >= now() - interval '30 days'
            GROUP BY 1
          ),
          waste AS (
            SELECT COALESCE(fw.material_type, 'Unknown') AS material, SUM(fw.grams)::float8 AS g
            FROM filament_waste_events fw
            WHERE fw.company_id = $1 AND fw.created_at >= now() - interval '30 days'
            GROUP BY 1
          )
          SELECT s.material,
                 s.remaining_grams,
                 s.spool_count,
                 ((COALESCE(b.g, 0) + COALESCE(w.g, 0)) / 30.0)::float8 AS burn_g_per_day
          FROM stock s
          LEFT JOIN burn b USING (material)
          LEFT JOIN waste w USING (material)
          ORDER BY CASE WHEN COALESCE(b.g, 0) + COALESCE(w.g, 0) > 0
                        THEN s.remaining_grams / ((COALESCE(b.g, 0) + COALESCE(w.g, 0)) / 30.0)
                   END ASC NULLS LAST
          LIMIT 30
        `,
        [companyId]
      );
      return {
        threshold_days: threshold,
        rows: rows.map((r) => {
          const burn = num(r.burn_g_per_day);
          const daysLeft = burn > 0 ? round1(num(r.remaining_grams) / burn) : null;
          return {
            material: r.material,
            remaining_grams: Math.round(num(r.remaining_grams)),
            spool_count: r.spool_count,
            burn_g_per_day: round1(burn),
            days_left: daysLeft,
            low: daysLeft !== null && daysLeft <= threshold
          };
        })
      };
    }
  },
  {
    name: "waste_summary",
    title: "Waste summary",
    description:
      "Failed-print material waste over a period vs the previous same-length period: total grams, cost and event count, broken down by material and by printer. Use for scrap/failure questions.",
    financial: false,
    params: periodParamsSchema,
    jsonSchema: periodJsonSchema,
    async run(db, companyId, params) {
      const p = resolvePeriod(params as { from?: string; to?: string });
      const [totals, byMaterial, byPrinter] = await Promise.all([
        db.query<{ grams: string; cost: string; events: number; grams_prev: string; cost_prev: string; events_prev: number }>(
          `
            SELECT
              COALESCE(SUM(fw.grams) FILTER (WHERE fw.created_at >= $2::date AND fw.created_at < ($3::date + 1)), 0)::text AS grams,
              COALESCE(SUM(fw.cost) FILTER (WHERE fw.created_at >= $2::date AND fw.created_at < ($3::date + 1)), 0)::text AS cost,
              COUNT(*) FILTER (WHERE fw.created_at >= $2::date AND fw.created_at < ($3::date + 1))::int AS events,
              COALESCE(SUM(fw.grams) FILTER (WHERE fw.created_at >= $4::date AND fw.created_at < ($5::date + 1)), 0)::text AS grams_prev,
              COALESCE(SUM(fw.cost) FILTER (WHERE fw.created_at >= $4::date AND fw.created_at < ($5::date + 1)), 0)::text AS cost_prev,
              COUNT(*) FILTER (WHERE fw.created_at >= $4::date AND fw.created_at < ($5::date + 1))::int AS events_prev
            FROM filament_waste_events fw
            WHERE fw.company_id = $1
          `,
          [companyId, p.from, p.to, p.prevFrom, p.prevTo]
        ),
        db.query<{ material: string; grams: string; cost: string; events: number }>(
          `
            SELECT COALESCE(fw.material_type, 'Unknown') AS material,
                   SUM(fw.grams)::text AS grams, SUM(fw.cost)::text AS cost, COUNT(*)::int AS events
            FROM filament_waste_events fw
            WHERE fw.company_id = $1 AND fw.created_at >= $2::date AND fw.created_at < ($3::date + 1)
            GROUP BY 1 ORDER BY SUM(fw.grams) DESC LIMIT 12
          `,
          [companyId, p.from, p.to]
        ),
        db.query<{ label: string | null; grams: string; cost: string; events: number }>(
          `
            SELECT NULLIF(TRIM(CONCAT_WS(' ', pi.brand, pi.model)), '') AS label,
                   SUM(fw.grams)::text AS grams, SUM(fw.cost)::text AS cost, COUNT(*)::int AS events
            FROM filament_waste_events fw
            LEFT JOIN order_pieces op ON op.piece_id = fw.piece_id
            LEFT JOIN printer_instances pi ON pi.printer_id = op.assigned_printer_id
            WHERE fw.company_id = $1 AND fw.created_at >= $2::date AND fw.created_at < ($3::date + 1)
            GROUP BY 1 ORDER BY SUM(fw.grams) DESC LIMIT 12
          `,
          [companyId, p.from, p.to]
        )
      ]);
      return {
        period: { from: p.from, to: p.to, prev_from: p.prevFrom, prev_to: p.prevTo },
        ...totals.rows[0],
        by_material: byMaterial.rows,
        by_printer: byPrinter.rows.map((r) => ({ ...r, label: r.label ?? "Unassigned" }))
      };
    }
  },

  // ── Wave 2 — paged dashboard ──────────────────────────────────────────────
  {
    name: "orders_timeseries",
    title: "Orders created vs fulfilled",
    description:
      "Orders created and orders fulfilled per day/week/month bucket over a period, INCLUDING empty buckets, with period totals and the previous same-length period's totals for comparison. Use for demand-vs-delivery pace questions ('are we keeping up with incoming orders').",
    financial: false,
    params: seriesParamsSchema,
    jsonSchema: seriesJsonSchema,
    async run(db, companyId, params) {
      const p = resolvePeriod(params as { from?: string; to?: string });
      const g = resolveGranularity(p.spanDays, (params as { granularity?: string }).granularity);
      const [series, totals] = await Promise.all([
        db.query<{ t: string; created: number; fulfilled: number }>(
          `
            WITH buckets AS (
              SELECT generate_series(date_trunc($4, $2::date), date_trunc($4, $3::date), ('1 ' || $4)::interval)::date AS t
            ),
            created AS (
              SELECT date_trunc($4, o.created_at)::date AS t, COUNT(*) AS n
              FROM orders o
              WHERE o.company_id = $1 AND o.created_at >= $2::date AND o.created_at < ($3::date + 1)
              GROUP BY 1
            ),
            fulfilled AS (
              SELECT date_trunc($4, o.fulfilled_at)::date AS t, COUNT(*) AS n
              FROM orders o
              WHERE o.company_id = $1 AND o.fulfilled_at >= $2::date AND o.fulfilled_at < ($3::date + 1)
              GROUP BY 1
            )
            SELECT b.t::text AS t,
                   COALESCE(c.n, 0)::int AS created,
                   COALESCE(f.n, 0)::int AS fulfilled
            FROM buckets b
            LEFT JOIN created c ON c.t = b.t
            LEFT JOIN fulfilled f ON f.t = b.t
            ORDER BY b.t
          `,
          [companyId, p.from, p.to, g]
        ),
        db.query<{ created: number; fulfilled: number; created_prev: number; fulfilled_prev: number }>(
          `
            SELECT
              (SELECT COUNT(*) FROM orders o WHERE o.company_id = $1 AND o.created_at >= $2::date AND o.created_at < ($3::date + 1))::int AS created,
              (SELECT COUNT(*) FROM orders o WHERE o.company_id = $1 AND o.fulfilled_at >= $2::date AND o.fulfilled_at < ($3::date + 1))::int AS fulfilled,
              (SELECT COUNT(*) FROM orders o WHERE o.company_id = $1 AND o.created_at >= $4::date AND o.created_at < ($5::date + 1))::int AS created_prev,
              (SELECT COUNT(*) FROM orders o WHERE o.company_id = $1 AND o.fulfilled_at >= $4::date AND o.fulfilled_at < ($5::date + 1))::int AS fulfilled_prev
          `,
          [companyId, p.from, p.to, p.prevFrom, p.prevTo]
        )
      ]);
      return {
        period: { from: p.from, to: p.to, prev_from: p.prevFrom, prev_to: p.prevTo },
        granularity: g,
        buckets: series.rows,
        ...totals.rows[0]
      };
    }
  },
  {
    name: "customer_growth",
    title: "Customer growth",
    description:
      "New CRM customers added per day/week/month bucket over a period (empty buckets included), plus totals: customers added this period, the previous same-length period, and the all-time customer count. Counts only — no money. Use for 'is our customer base growing' questions.",
    financial: false,
    params: seriesParamsSchema,
    jsonSchema: seriesJsonSchema,
    async run(db, companyId, params) {
      const p = resolvePeriod(params as { from?: string; to?: string });
      const g = resolveGranularity(p.spanDays, (params as { granularity?: string }).granularity);
      const [series, totals] = await Promise.all([
        db.query<{ t: string; added: number }>(
          `
            WITH buckets AS (
              SELECT generate_series(date_trunc($4, $2::date), date_trunc($4, $3::date), ('1 ' || $4)::interval)::date AS t
            ),
            agg AS (
              SELECT date_trunc($4, c.created_at)::date AS t, COUNT(*) AS n
              FROM customers c
              WHERE c.company_id = $1 AND c.created_at >= $2::date AND c.created_at < ($3::date + 1)
              GROUP BY 1
            )
            SELECT b.t::text AS t, COALESCE(a.n, 0)::int AS added
            FROM buckets b LEFT JOIN agg a ON a.t = b.t
            ORDER BY b.t
          `,
          [companyId, p.from, p.to, g]
        ),
        db.query<{ added: number; added_prev: number; total: number }>(
          `
            SELECT
              (SELECT COUNT(*) FROM customers c WHERE c.company_id = $1 AND c.created_at >= $2::date AND c.created_at < ($3::date + 1))::int AS added,
              (SELECT COUNT(*) FROM customers c WHERE c.company_id = $1 AND c.created_at >= $4::date AND c.created_at < ($5::date + 1))::int AS added_prev,
              (SELECT COUNT(*) FROM customers c WHERE c.company_id = $1)::int AS total
          `,
          [companyId, p.from, p.to, p.prevFrom, p.prevTo]
        )
      ]);
      return {
        period: { from: p.from, to: p.to, prev_from: p.prevFrom, prev_to: p.prevTo },
        granularity: g,
        buckets: series.rows,
        ...totals.rows[0]
      };
    }
  },
  {
    name: "material_consumption",
    title: "Material consumption",
    description:
      "Filament consumed by completed pieces over a period, per material: grams, pieces, share_pct of period grams, and the previous same-length period's grams for comparison. Consumption only — failed-print scrap lives in waste_summary. Use for 'what materials do we actually print with' questions.",
    financial: false,
    params: periodParamsSchema,
    jsonSchema: periodJsonSchema,
    async run(db, companyId, params) {
      const p = resolvePeriod(params as { from?: string; to?: string });
      const { rows } = await db.query<{ material: string; grams: number; pieces: number; grams_prev: number }>(
        `
          WITH cur AS (
            SELECT COALESCE(op.required_filament_material, 'Unknown') AS material,
                   SUM(COALESCE(op.slicer_filament_used_grams, 0))::float8 AS grams,
                   COUNT(*)::int AS pieces
            FROM order_pieces op
            WHERE op.company_id = $1
              AND op.print_completed_at >= $2::date AND op.print_completed_at < ($3::date + 1)
            GROUP BY 1
          ),
          prev AS (
            SELECT COALESCE(op.required_filament_material, 'Unknown') AS material,
                   SUM(COALESCE(op.slicer_filament_used_grams, 0))::float8 AS grams
            FROM order_pieces op
            WHERE op.company_id = $1
              AND op.print_completed_at >= $4::date AND op.print_completed_at < ($5::date + 1)
            GROUP BY 1
          )
          SELECT COALESCE(c.material, pr.material) AS material,
                 COALESCE(c.grams, 0)::float8 AS grams,
                 COALESCE(c.pieces, 0)::int AS pieces,
                 COALESCE(pr.grams, 0)::float8 AS grams_prev
          FROM cur c
          FULL OUTER JOIN prev pr ON pr.material = c.material
          ORDER BY COALESCE(c.grams, 0) DESC
          LIMIT 20
        `,
        [companyId, p.from, p.to, p.prevFrom, p.prevTo]
      );
      const total = rows.reduce((s, r) => s + num(r.grams), 0);
      return {
        period: { from: p.from, to: p.to, prev_from: p.prevFrom, prev_to: p.prevTo },
        total_grams: Math.round(total),
        rows: rows.map((r) => ({
          material: r.material,
          grams: Math.round(num(r.grams)),
          pieces: r.pieces,
          grams_prev: Math.round(num(r.grams_prev)),
          share_pct: total > 0 ? round1((num(r.grams) / total) * 100) : null
        }))
      };
    }
  },
  {
    name: "invoice_status_mix",
    title: "Invoice status mix",
    description:
      "Current snapshot of ALL invoices by status (draft, open, partial, paid, void): count, total value, and outstanding balance per status. No period parameters. Use for 'how much is drafted / billed / collected' questions.",
    financial: true,
    params: emptyParamsSchema,
    jsonSchema: emptyJsonSchema,
    async run(db, companyId) {
      const { rows } = await db.query<{ status: string; n: number; total: string; balance: string }>(
        `
          SELECT i.status,
                 COUNT(*)::int AS n,
                 COALESCE(SUM(i.total), 0)::text AS total,
                 COALESCE(SUM(i.balance_due), 0)::text AS balance
          FROM invoices i
          WHERE i.company_id = $1
          GROUP BY i.status
        `,
        [companyId]
      );
      const order = ["draft", "open", "partial", "paid", "void"];
      return {
        statuses: order.map((s) => rows.find((r) => r.status === s) ?? { status: s, n: 0, total: "0", balance: "0" })
      };
    }
  }
];

export const TOOLS_BY_NAME = new Map(ANALYTICS_TOOLS.map((t) => [t.name, t]));
