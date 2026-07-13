import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { parseWithSchema } from "../common/zod";
import { ANALYTICS_TOOLS, TOOLS_BY_NAME, resolvePeriod, type AnalyticsTool } from "./analytics-tools";

// ════════════════════════════════════════════════════════════════
// AnalyticsService — executes registry tools with per-tool access control,
// and computes the deterministic "insights" chips for the dashboard strip.
//
// Access model (mirrors the tab gating client-side):
//   · financial tools  → view_finance  (money boundary — same one the whole
//     Finance module already uses, so the dashboard reveals nothing a staffer
//     couldn't already see there)
//   · production tools → view_dashboard
//   · owners bypass both, PermissionGuard-style.
// The route itself is gated view_dashboard-OR-view_finance; this class does
// the finer per-tool check because /t/:name is one dynamic route.
// ════════════════════════════════════════════════════════════════

export interface AnalyticsAccess {
  userRole: "owner" | "staff";
  permissions: Record<string, boolean>;
}

export interface InsightChip {
  id: string;
  severity: "info" | "warn" | "alert";
  text: string;
  /** Registry tool that backs this chip — the client uses it to link/scroll. */
  tool: string;
}

const hasPerm = (a: AnalyticsAccess, key: string) =>
  a.userRole === "owner" || a.permissions?.[key] === true;

export const canUseTool = (a: AnalyticsAccess, tool: AnalyticsTool) =>
  tool.financial ? hasPerm(a, "view_finance") : hasPerm(a, "view_dashboard");

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const pctDelta = (cur: number, prev: number): number | null =>
  prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null;

@Injectable()
export class AnalyticsService {
  constructor(private readonly databaseService: DatabaseService) {}

  /** Tool metadata for the client (card params live there) and the Ask dock. */
  listTools(access: AnalyticsAccess) {
    return ANALYTICS_TOOLS.filter((t) => canUseTool(access, t)).map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      financial: t.financial,
      params: t.jsonSchema
    }));
  }

  /** One-call bootstrap for the dashboard: visible tools + tenant currency. */
  async meta(companyId: string, access: AnalyticsAccess) {
    const { rows } = await this.databaseService.query<{ currency_code: string | null }>(
      `SELECT currency_code FROM finance_settings WHERE company_id = $1`,
      [companyId]
    );
    return {
      currency_code: rows[0]?.currency_code ?? null,
      tools: this.listTools(access)
    };
  }

  /** Validate access + params, then run. companyId comes from the auth guard,
   *  never from params — the model / query string cannot address a tenant. */
  async execute(name: string, rawParams: Record<string, unknown>, companyId: string, access: AnalyticsAccess) {
    const tool = TOOLS_BY_NAME.get(name);
    if (!tool) throw new NotFoundException(`Unknown analytics tool: ${name}`);
    if (!canUseTool(access, tool)) {
      throw new ForbiddenException(
        tool.financial
          ? "Financial analytics require finance access."
          : "Missing required permission: view_dashboard"
      );
    }
    const params = parseWithSchema(tool.params, rawParams) as Record<string, unknown>;
    return tool.run(this.databaseService, companyId, params);
  }

  // ── Insights strip — deterministic rule engine, no LLM ────────────────────
  // Every chip is computed from the SAME tools the cards render, so clicking
  // through never shows a different number.
  async insights(companyId: string, access: AnalyticsAccess): Promise<{ chips: InsightChip[] }> {
    const finance = ANALYTICS_TOOLS.some((t) => t.financial && canUseTool(access, t));
    const production = ANALYTICS_TOOLS.some((t) => !t.financial && canUseTool(access, t));
    const period = resolvePeriod({});
    const chips: InsightChip[] = [];

    const [kpi, runway, printers, backlog, customers] = await Promise.all([
      finance ? this.execute("kpi_summary", {}, companyId, access) : null,
      production ? this.execute("filament_runway", {}, companyId, access) : null,
      production ? this.execute("printer_utilization", {}, companyId, access) : null,
      production ? this.execute("queue_backlog", {}, companyId, access) : null,
      finance ? this.execute("top_customers", { limit: 3 }, companyId, access) : null
    ]);

    if (kpi) {
      const k = kpi as Record<string, unknown>;
      const rev = num(k.revenue);
      const revPrev = num(k.revenue_prev);
      const revDelta = pctDelta(rev, revPrev);
      if (revDelta !== null && Math.abs(revDelta) >= 15 && (rev > 0 || revPrev > 0)) {
        chips.push({
          id: "revenue-delta",
          severity: revDelta >= 0 ? "info" : "warn",
          text: `Billed revenue ${revDelta >= 0 ? "up" : "down"} ${Math.abs(revDelta)}% vs the previous ${period.spanDays} days`,
          tool: "revenue_timeseries"
        });
      }
      const aovDelta = pctDelta(num(k.aov), num(k.aov_prev));
      if (aovDelta !== null && Math.abs(aovDelta) >= 15 && num(k.invoice_count) >= 3) {
        chips.push({
          id: "aov-delta",
          severity: aovDelta >= 0 ? "info" : "warn",
          text: `Average order value ${aovDelta >= 0 ? "grew" : "fell"} ${Math.abs(aovDelta)}% period-over-period`,
          tool: "aov_timeseries"
        });
      }
      const margin = k.gross_margin_pct;
      if (typeof margin === "number" && num(k.ledger_revenue) > 0 && margin < 20) {
        chips.push({
          id: "margin-low",
          severity: "warn",
          text: `Gross margin is ${margin}% on the posted ledger — under the 20% floor`,
          tool: "pnl_summary"
        });
      }
      const ar = num(k.ar_open_balance);
      if (ar > 0) {
        chips.push({
          id: "ar-open",
          severity: "info",
          text: `${num(k.ar_open_balance).toLocaleString()} in receivables is still uncollected`,
          tool: "ar_aging"
        });
      }
    }

    if (customers) {
      const rows = (customers as { rows: { name: string; share_pct: number | null }[] }).rows ?? [];
      const top = rows[0];
      if (top && top.share_pct !== null && top.share_pct >= 50) {
        chips.push({
          id: "concentration",
          severity: "warn",
          text: `${top.name} is ${top.share_pct}% of period revenue — concentration risk`,
          tool: "top_customers"
        });
      }
    }

    if (runway) {
      const low = ((runway as { rows: { material: string; days_left: number | null; low: boolean }[] }).rows ?? [])
        .filter((r) => r.low)
        .slice(0, 2);
      for (const r of low) {
        chips.push({
          id: `runway-${r.material}`,
          severity: "alert",
          text: `${r.material} runs out in ~${r.days_left} days at the current burn rate`,
          tool: "filament_runway"
        });
      }
    }

    if (printers) {
      const rows = (printers as { rows: { label: string | null; waste_events: number }[] }).rows ?? [];
      if (rows.length >= 2) {
        const events = rows.map((r) => r.waste_events).sort((a, b) => a - b);
        const median = events[Math.floor(events.length / 2)] ?? 0;
        const outlier = rows.find((r) => r.waste_events >= 3 && r.waste_events >= 2 * Math.max(median, 1));
        if (outlier) {
          chips.push({
            id: "failure-outlier",
            severity: "warn",
            text: `${outlier.label ?? "A printer"} logged ${outlier.waste_events} failed prints — ${median === 0 ? "the rest of the fleet has none" : `${Math.round(outlier.waste_events / Math.max(median, 1))}× the fleet median`}`,
            tool: "printer_utilization"
          });
        }
      }
    }

    if (backlog) {
      const b = backlog as { backlog_hours: number; est_clear_days: number | null };
      if (b.est_clear_days !== null && b.est_clear_days > 7) {
        chips.push({
          id: "backlog-deep",
          severity: "warn",
          text: `${b.backlog_hours}h of queued printing — about ${b.est_clear_days} days at the recent pace`,
          tool: "queue_backlog"
        });
      }
    }

    const rank = { alert: 0, warn: 1, info: 2 } as const;
    chips.sort((a, b) => rank[a.severity] - rank[b.severity]);
    return { chips: chips.slice(0, 6) };
  }
}
