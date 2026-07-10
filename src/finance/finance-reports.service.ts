import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";

// ════════════════════════════════════════════════════════════════
// FinanceReportsService — read-only rollups over the posted ledger.
//
// Sign conventions (classical accounting):
//   debit-normal  (asset, expense):            balance = Σdebit − Σcredit
//   credit-normal (liability, equity, revenue): balance = Σcredit − Σdebit
// Every figure is returned as text (NUMERIC comes back as string from pg);
// the client renders, never re-derives.
// ════════════════════════════════════════════════════════════════

@Injectable()
export class FinanceReportsService {
  constructor(private readonly databaseService: DatabaseService) {}

  // Trial balance: per-account debit/credit totals over a period. The two
  // grand totals must be equal — that is the whole point of the report.
  async trialBalance(
    companyId: string,
    query: { from?: string | undefined; to?: string | undefined }
  ) {
    const values: unknown[] = [companyId];
    const dateFilters: string[] = [];
    if (query.from) {
      values.push(query.from);
      dateFilters.push(`e.entry_date >= $${values.length}`);
    }
    if (query.to) {
      values.push(query.to);
      dateFilters.push(`e.entry_date <= $${values.length}`);
    }
    const dateClause = dateFilters.length ? `AND ${dateFilters.join(" AND ")}` : "";

    const result = await this.databaseService.query(
      `
        SELECT
          a.account_id, a.code, a.name, a.account_type,
          COALESCE(SUM(l.debit), 0)::text  AS total_debit,
          COALESCE(SUM(l.credit), 0)::text AS total_credit
        FROM finance_accounts a
        LEFT JOIN journal_lines l ON l.account_id = a.account_id AND l.company_id = a.company_id
        LEFT JOIN journal_entries e ON e.entry_id = l.entry_id AND e.status = 'posted' ${dateClause}
        WHERE a.company_id = $1
        GROUP BY a.account_id
        HAVING COALESCE(SUM(l.debit), 0) <> 0 OR COALESCE(SUM(l.credit), 0) <> 0
        ORDER BY a.code
      `,
      values
    );
    return result.rows;
  }

  // Profit & loss: revenue and expense activity over a period, plus net income.
  async profitAndLoss(
    companyId: string,
    query: { from?: string | undefined; to?: string | undefined }
  ) {
    const values: unknown[] = [companyId];
    const dateFilters: string[] = [];
    if (query.from) {
      values.push(query.from);
      dateFilters.push(`e.entry_date >= $${values.length}`);
    }
    if (query.to) {
      values.push(query.to);
      dateFilters.push(`e.entry_date <= $${values.length}`);
    }
    const dateClause = dateFilters.length ? `AND ${dateFilters.join(" AND ")}` : "";

    const result = await this.databaseService.query<{
      account_id: string;
      code: string;
      name: string;
      account_type: string;
      amount: string;
    }>(
      `
        SELECT
          a.account_id, a.code, a.name, a.account_type,
          CASE WHEN a.account_type = 'revenue'
            THEN COALESCE(SUM(l.credit - l.debit), 0)
            ELSE COALESCE(SUM(l.debit - l.credit), 0)
          END::text AS amount
        FROM finance_accounts a
        JOIN journal_lines l ON l.account_id = a.account_id AND l.company_id = a.company_id
        JOIN journal_entries e ON e.entry_id = l.entry_id AND e.status = 'posted' ${dateClause}
        WHERE a.company_id = $1
          AND a.account_type IN ('revenue', 'expense')
        GROUP BY a.account_id
        HAVING SUM(l.debit) <> 0 OR SUM(l.credit) <> 0
        ORDER BY a.account_type DESC, a.code
      `,
      values
    );

    let revenue = 0;
    let expenses = 0;
    for (const row of result.rows) {
      const amount = Number(row.amount);
      if (row.account_type === "revenue") revenue += amount;
      else expenses += amount;
    }

    return {
      accounts: result.rows,
      totals: {
        revenue: revenue.toFixed(2),
        expenses: expenses.toFixed(2),
        net_income: (revenue - expenses).toFixed(2)
      }
    };
  }

  // Balance sheet as of a date. Assets = Liabilities + Equity holds because
  // retained-from-operations earnings (all P&L activity up to the date) are
  // rolled into equity as a virtual "Current Earnings" row.
  async balanceSheet(companyId: string, asOf?: string) {
    const values: unknown[] = [companyId];
    let dateClause = "";
    if (asOf) {
      values.push(asOf);
      dateClause = `AND e.entry_date <= $${values.length}`;
    }

    const result = await this.databaseService.query<{
      account_id: string;
      code: string;
      name: string;
      account_type: string;
      balance: string;
    }>(
      `
        SELECT
          a.account_id, a.code, a.name, a.account_type,
          CASE WHEN a.account_type IN ('asset', 'expense')
            THEN COALESCE(SUM(l.debit - l.credit), 0)
            ELSE COALESCE(SUM(l.credit - l.debit), 0)
          END::text AS balance
        FROM finance_accounts a
        JOIN journal_lines l ON l.account_id = a.account_id AND l.company_id = a.company_id
        JOIN journal_entries e ON e.entry_id = l.entry_id AND e.status = 'posted' ${dateClause}
        WHERE a.company_id = $1
        GROUP BY a.account_id
        HAVING SUM(l.debit) <> 0 OR SUM(l.credit) <> 0
        ORDER BY a.code
      `,
      values
    );

    const assets: typeof result.rows = [];
    const liabilities: typeof result.rows = [];
    const equity: typeof result.rows = [];
    let assetTotal = 0;
    let liabilityTotal = 0;
    let equityTotal = 0;
    let earnings = 0;

    for (const row of result.rows) {
      const balance = Number(row.balance);
      switch (row.account_type) {
        case "asset":
          assets.push(row);
          assetTotal += balance;
          break;
        case "liability":
          liabilities.push(row);
          liabilityTotal += balance;
          break;
        case "equity":
          equity.push(row);
          equityTotal += balance;
          break;
        case "revenue":
          earnings += balance;
          break;
        case "expense":
          earnings -= balance;
          break;
      }
    }

    return {
      as_of: asOf ?? new Date().toISOString().slice(0, 10),
      assets,
      liabilities,
      equity,
      totals: {
        assets: assetTotal.toFixed(2),
        liabilities: liabilityTotal.toFixed(2),
        equity: equityTotal.toFixed(2),
        current_earnings: earnings.toFixed(2),
        liabilities_and_equity: (liabilityTotal + equityTotal + earnings).toFixed(2)
      }
    };
  }


  // Dashboard rollup: the headline numbers plus a 6-month net-income series.
  async summary(companyId: string) {
    const [cash, ar, ap, month, series, counts, consumedFilament] = await Promise.all([
      // Cash on hand: every asset account tagged cash/bank.
      this.databaseService.query<{ total: string }>(
        `
          SELECT COALESCE(SUM(l.debit - l.credit), 0)::text AS total
          FROM journal_lines l
          JOIN journal_entries e ON e.entry_id = l.entry_id AND e.status = 'posted'
          JOIN finance_accounts a ON a.account_id = l.account_id
          WHERE l.company_id = $1 AND a.account_subtype IN ('cash', 'bank')
        `,
        [companyId]
      ),
      this.databaseService.query<{ total: string; count: string }>(
        `SELECT COALESCE(SUM(balance_due), 0)::text AS total, COUNT(*)::text AS count FROM invoices WHERE company_id = $1 AND status IN ('open', 'partial')`,
        [companyId]
      ),
      this.databaseService.query<{ total: string; count: string }>(
        `SELECT COALESCE(SUM(balance_due), 0)::text AS total, COUNT(*)::text AS count FROM bills WHERE company_id = $1 AND status IN ('open', 'partial')`,
        [companyId]
      ),
      // This calendar month's P&L movement.
      this.databaseService.query<{ revenue: string; expenses: string }>(
        `
          SELECT
            COALESCE(SUM(CASE WHEN a.account_type = 'revenue' THEN l.credit - l.debit ELSE 0 END), 0)::text AS revenue,
            COALESCE(SUM(CASE WHEN a.account_type = 'expense' THEN l.debit - l.credit ELSE 0 END), 0)::text AS expenses
          FROM journal_lines l
          JOIN journal_entries e ON e.entry_id = l.entry_id AND e.status = 'posted'
          JOIN finance_accounts a ON a.account_id = l.account_id
          WHERE l.company_id = $1
            AND e.entry_date >= date_trunc('month', CURRENT_DATE)::date
        `,
        [companyId]
      ),
      // Month-by-month revenue/expense for the last 6 months (sparkline).
      this.databaseService.query<{ month: string; revenue: string; expenses: string }>(
        `
          SELECT
            to_char(date_trunc('month', e.entry_date), 'YYYY-MM') AS month,
            COALESCE(SUM(CASE WHEN a.account_type = 'revenue' THEN l.credit - l.debit ELSE 0 END), 0)::text AS revenue,
            COALESCE(SUM(CASE WHEN a.account_type = 'expense' THEN l.debit - l.credit ELSE 0 END), 0)::text AS expenses
          FROM journal_lines l
          JOIN journal_entries e ON e.entry_id = l.entry_id AND e.status = 'posted'
          JOIN finance_accounts a ON a.account_id = l.account_id
          WHERE l.company_id = $1
            AND a.account_type IN ('revenue', 'expense')
            AND e.entry_date >= (date_trunc('month', CURRENT_DATE) - INTERVAL '5 months')::date
          GROUP BY 1
          ORDER BY 1
        `,
        [companyId]
      ),
      this.databaseService.query<{ draft_invoices: string; journal_entries: string }>(
        `
          SELECT
            (SELECT COUNT(*) FROM invoices WHERE company_id = $1 AND status = 'draft')::text AS draft_invoices,
            (SELECT COUNT(*) FROM journal_entries WHERE company_id = $1 AND status = 'posted')::text AS journal_entries
        `,
        [companyId]
      ),
      // Filament is a consumable, not a balance-sheet asset: report the COST of
      // filament actually consumed this month (pieces finished this month).
      this.consumedFilamentThisMonth(companyId)
    ]);

    return {
      cash: cash.rows[0]?.total ?? "0",
      receivables: { total: ar.rows[0]?.total ?? "0", count: Number(ar.rows[0]?.count ?? 0) },
      payables: { total: ap.rows[0]?.total ?? "0", count: Number(ap.rows[0]?.count ?? 0) },
      this_month: {
        revenue: month.rows[0]?.revenue ?? "0",
        expenses: month.rows[0]?.expenses ?? "0",
        net_income: (Number(month.rows[0]?.revenue ?? 0) - Number(month.rows[0]?.expenses ?? 0)).toFixed(2)
      },
      monthly_series: series.rows,
      draft_invoices: Number(counts.rows[0]?.draft_invoices ?? 0),
      posted_entries: Number(counts.rows[0]?.journal_entries ?? 0),
      // Consumable usage — filament burned this month (cost + grams).
      consumed_filament: consumedFilament
    };
  }

  // Cost of filament consumed this calendar month: every piece that finished
  // printing (print_completed_at) since the 1st, valued at each slot's material
  // grams × that material's avg price/gram. Mirrors the material portion of the
  // piece-costing engine so the number reconciles with order costs.
  async consumedFilamentThisMonth(companyId: string) {
    const matRes = await this.databaseService.query<{ material_type: string; p: string | null }>(
      `
        SELECT fr.material_type,
               SUM(ai.purchase_price) / NULLIF(SUM(ai.initial_grams), 0) AS p
        FROM asset_instances ai
        JOIN filament_reference fr ON fr.filament_ref_id = ai.filament_ref_id
        WHERE ai.company_id = $1
          AND ai.asset_type = 'filament_spool'
          AND ai.parent_asset_id IS NULL
          AND ai.purchase_price > 0
          AND ai.initial_grams > 0
          AND fr.material_type IS NOT NULL
        GROUP BY fr.material_type
      `,
      [companyId]
    );
    const matMap = new Map<string, number>();
    for (const r of matRes.rows) {
      if (r.p != null && Number.isFinite(Number(r.p))) matMap.set(r.material_type, Number(r.p));
    }

    const pieces = await this.databaseService.query<{
      cost_inputs: { grams?: string[] } | null;
      required_filament_material: string | null;
      requires_multicolor: boolean;
      color_slots: { slot_material: string }[] | null;
    }>(
      `
        SELECT op.cost_inputs, op.required_filament_material, op.requires_multicolor,
               (
                 SELECT COALESCE(json_agg(json_build_object('slot_material', cs.slot_material) ORDER BY cs.sequence_order), '[]'::json)
                 FROM order_piece_color_slots cs WHERE cs.piece_id = op.piece_id
               ) AS color_slots
        FROM order_pieces op
        WHERE op.company_id = $1
          AND op.print_completed_at >= date_trunc('month', CURRENT_DATE)
      `,
      [companyId]
    );

    let cost = 0;
    let grams = 0;
    for (const p of pieces.rows) {
      const gramList = (p.cost_inputs?.grams ?? []).map((g) => Number(g) || 0);
      for (let j = 0; j < gramList.length; j += 1) {
        const g = gramList[j] || 0;
        if (g <= 0) continue;
        grams += g;
        const mat = p.requires_multicolor && p.color_slots?.[j]
          ? p.color_slots[j]!.slot_material
          : p.required_filament_material ?? undefined;
        const price = mat ? matMap.get(mat) : undefined;
        if (price != null) cost += price * g;
      }
    }

    return {
      cost: (Math.round(cost * 100) / 100).toFixed(2),
      grams: Math.round(grams),
      piece_count: pieces.rows.length
    };
  }
}
