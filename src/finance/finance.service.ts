import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { PoolClient } from "pg";
import type { z } from "zod";
import { buildUpdateClause } from "../common/sql";
import { DatabaseService } from "../database/database.service";
import { OrderCostingService } from "../orders/order-costing";
import type {
  DocumentLineInput,
  createAccountSchema,
  createBillSchema,
  createExpenseSchema,
  createInvoiceSchema,
  createJournalEntrySchema,
  createPaymentSchema,
  createRecurringBillSchema,
  ledgerQuerySchema,
  listAccountsQuerySchema,
  listBillsQuerySchema,
  listExpensesQuerySchema,
  listInvoicesQuerySchema,
  listJournalQuerySchema,
  listPaymentsQuerySchema,
  listVendorsQuerySchema,
  updateBillSchema,
  updateInvoiceSchema
} from "./finance.schemas";

// ════════════════════════════════════════════════════════════════
// FinanceService — conventional double-entry engine.
//
// Every money decision happens in integer cents; the database stores
// NUMERIC(14,2). Documents (invoices/bills/payments/expenses) post journal
// entries on issue/record and keep the entry id for provenance. Voiding
// posts a dated REVERSAL entry — the ledger itself is append-only, which the
// DB triggers in 2026-07-08_finance_core.sql also enforce.
// ════════════════════════════════════════════════════════════════

type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
type UpdateInvoiceInput = z.infer<typeof updateInvoiceSchema>;
type CreateBillInput = z.infer<typeof createBillSchema>;
type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
type CreateExpenseInput = z.infer<typeof createExpenseSchema>;
type CreateJournalEntryInput = z.infer<typeof createJournalEntrySchema>;
type UpdateBillInput = z.infer<typeof updateBillSchema>;
type CreateRecurringBillInput = z.infer<typeof createRecurringBillSchema>;

// NUMERIC arrives from pg as a string; every reader goes through here.
function cents(value: string | number | null | undefined): number {
  if (value == null || value === "") return 0;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function fromCents(c: number): number {
  return Math.round(c) / 100;
}

const DOC_PREFIX: Record<string, string> = {
  invoice: "INV",
  bill: "BILL",
  payment: "PAY",
  expense: "EXP",
  journal: "JE"
};

type JournalLineSpec = {
  accountId: string;
  debit: number; // cents
  credit: number; // cents
  description?: string | null;
};

@Injectable()
export class FinanceService {
  constructor(
    private readonly databaseService: DatabaseService,
    // Prices an order exactly as the Orders UI does, so an invoice generated
    // from an order matches the quoted total and its COGS basis is the order's
    // real cost.
    private readonly orderCosting: OrderCostingService
  ) {}

  // ── Numbering + posting primitives ────────────────────────────────────────

  // Mint the next business number for a document type: INV-2026-00042.
  // Same atomic upsert-counter pattern as order numbers.
  private async nextDocNumber(
    client: PoolClient,
    companyId: string,
    docType: keyof typeof DOC_PREFIX,
    onDate: string
  ): Promise<string> {
    const year = Number(onDate.slice(0, 4));
    const result = await this.databaseService.query<{ last_value: string }>(
      `
        INSERT INTO finance_doc_sequences (company_id, doc_type, year, last_value)
        VALUES ($1, $2, $3, 1)
        ON CONFLICT (company_id, doc_type, year)
        DO UPDATE SET last_value = finance_doc_sequences.last_value + 1
        RETURNING last_value
      `,
      [companyId, docType, year],
      client
    );
    const seq = String(result.rows[0]!.last_value).padStart(5, "0");
    return `${DOC_PREFIX[docType]}-${year}-${seq}`;
  }

  // Resolve the tenant's system account for a posting role (e.g. "the" A/R).
  // Accounts are user-deletable (see deleteAccount), so a hook the posting
  // engine needs might be gone. Rather than fail, self-heal: re-run the
  // idempotent default-account seed (which re-creates any missing hook by its
  // subtype) and look again. Only a genuinely un-seeded company (migration not
  // applied) still throws.
  private async systemAccount(
    client: PoolClient,
    companyId: string,
    subtype: string
  ): Promise<string> {
    const lookup = () =>
      this.databaseService.query<{ account_id: string }>(
        `
          SELECT account_id
          FROM finance_accounts
          WHERE company_id = $1
            AND account_subtype = $2
          ORDER BY code
          LIMIT 1
        `,
        [companyId, subtype],
        client
      );

    let result = await lookup();
    if (!result.rows[0]) {
      await this.databaseService.query(
        `SELECT public.finance_seed_default_accounts($1)`,
        [companyId],
        client
      );
      result = await lookup();
    }

    const row = result.rows[0];
    if (!row) {
      throw new ConflictException(
        `Finance is not initialised for this company (missing system account '${subtype}'). Apply the finance migration.`
      );
    }
    return row.account_id;
  }

  private async assertUnlocked(
    client: PoolClient,
    companyId: string,
    onDate: string
  ) {
    const result = await this.databaseService.query<{ lock_date: string | null }>(
      `SELECT lock_date::text FROM finance_settings WHERE company_id = $1`,
      [companyId],
      client
    );
    const lockDate = result.rows[0]?.lock_date ?? null;
    if (lockDate && onDate <= lockDate) {
      throw new BadRequestException(
        `Books are locked through ${lockDate}; pick a later date.`
      );
    }
  }

  // Insert a balanced, posted journal entry. Lines must already balance —
  // the deferred DB trigger is the backstop, this is the fast failure.
  private async postEntry(
    client: PoolClient,
    companyId: string,
    userId: string | null,
    params: {
      entryDate: string;
      memo?: string | null;
      sourceType: "manual" | "invoice" | "bill" | "payment" | "expense" | "reversal";
      sourceId?: string | null;
      reversesEntryId?: string | null;
      lines: JournalLineSpec[];
    }
  ): Promise<{ entry_id: string; entry_number: string }> {
    const debits = params.lines.reduce((s, l) => s + l.debit, 0);
    const credits = params.lines.reduce((s, l) => s + l.credit, 0);
    if (params.lines.length < 2 || debits !== credits || debits <= 0) {
      throw new BadRequestException("Journal entry does not balance.");
    }

    await this.assertUnlocked(client, companyId, params.entryDate);
    const entryNumber = await this.nextDocNumber(client, companyId, "journal", params.entryDate);

    const entryResult = await this.databaseService.query<{ entry_id: string }>(
      `
        INSERT INTO journal_entries
          (company_id, entry_number, entry_date, memo, status, source_type, source_id, reverses_entry_id, posted_at, created_by)
        VALUES ($1, $2, $3, $4, 'posted', $5, $6, $7, NOW(), $8)
        RETURNING entry_id
      `,
      [
        companyId,
        entryNumber,
        params.entryDate,
        params.memo ?? null,
        params.sourceType,
        params.sourceId ?? null,
        params.reversesEntryId ?? null,
        userId
      ],
      client
    );
    const entryId = entryResult.rows[0]!.entry_id;

    for (let i = 0; i < params.lines.length; i += 1) {
      const line = params.lines[i]!;
      await this.databaseService.query(
        `
          INSERT INTO journal_lines
            (entry_id, company_id, account_id, debit, credit, description, position)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          entryId,
          companyId,
          line.accountId,
          fromCents(line.debit),
          fromCents(line.credit),
          line.description ?? null,
          i
        ],
        client
      );
    }

    return { entry_id: entryId, entry_number: entryNumber };
  }

  // Post the exact mirror of an existing entry (void mechanics).
  private async postReversal(
    client: PoolClient,
    companyId: string,
    userId: string | null,
    originalEntryId: string,
    memo: string,
    sourceId: string
  ) {
    const lines = await this.databaseService.query<{
      account_id: string;
      debit: string;
      credit: string;
      description: string | null;
    }>(
      `
        SELECT account_id, debit, credit, description
        FROM journal_lines
        WHERE entry_id = $1 AND company_id = $2
        ORDER BY position
      `,
      [originalEntryId, companyId],
      client
    );
    if (lines.rows.length === 0) {
      throw new ConflictException("Original journal entry has no lines to reverse.");
    }

    const today = new Date().toISOString().slice(0, 10);
    return this.postEntry(client, companyId, userId, {
      entryDate: today,
      memo,
      sourceType: "reversal",
      sourceId,
      reversesEntryId: originalEntryId,
      lines: lines.rows.map((l) => ({
        accountId: l.account_id,
        debit: cents(l.credit),
        credit: cents(l.debit),
        description: l.description
      }))
    });
  }

  // Validate that an account exists in this tenant, is active, and (when
  // given) matches an allowed type. Returns the row for further checks.
  private async requireAccount(
    client: PoolClient,
    companyId: string,
    accountId: string,
    allowedTypes?: string[]
  ) {
    const result = await this.databaseService.query<{
      account_id: string;
      account_type: string;
      is_active: boolean;
      name: string;
    }>(
      `
        SELECT account_id, account_type, is_active, name
        FROM finance_accounts
        WHERE company_id = $1 AND account_id = $2
      `,
      [companyId, accountId],
      client
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException("Account not found.");
    if (!row.is_active) {
      throw new BadRequestException(`Account "${row.name}" is inactive.`);
    }
    if (allowedTypes && !allowedTypes.includes(row.account_type)) {
      throw new BadRequestException(
        `Account "${row.name}" is ${row.account_type}; expected ${allowedTypes.join(" or ")}.`
      );
    }
    return row;
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  // ── Chart of accounts ─────────────────────────────────────────────────────

  async listAccounts(
    companyId: string,
    query: z.infer<typeof listAccountsQuerySchema>
  ) {
    const values: unknown[] = [companyId];
    const filters = ["a.company_id = $1"];
    if (query.is_active !== undefined) {
      values.push(query.is_active);
      filters.push(`a.is_active = $${values.length}`);
    }

    // Balance = Σdebit − Σcredit over posted lines; sign is presented by the
    // client per account type (debit-normal vs credit-normal).
    const result = await this.databaseService.query(
      `
        SELECT
          a.account_id, a.code, a.name, a.account_type, a.account_subtype,
          a.is_system, a.is_active, a.description, a.parent_account_id,
          a.created_at, a.updated_at
          ${query.include_balances ? `,
          COALESCE(b.debit_total, 0)::text  AS debit_total,
          COALESCE(b.credit_total, 0)::text AS credit_total,
          COALESCE(b.debit_total - b.credit_total, 0)::text AS balance` : ""}
        FROM finance_accounts a
        ${query.include_balances ? `
        LEFT JOIN (
          SELECT l.account_id, SUM(l.debit) AS debit_total, SUM(l.credit) AS credit_total
          FROM journal_lines l
          JOIN journal_entries e ON e.entry_id = l.entry_id AND e.status = 'posted'
          WHERE l.company_id = $1
          GROUP BY l.account_id
        ) b ON b.account_id = a.account_id` : ""}
        WHERE ${filters.join(" AND ")}
        ORDER BY a.code
      `,
      values
    );
    return result.rows;
  }

  async createAccount(
    companyId: string,
    input: z.infer<typeof createAccountSchema>
  ) {
    return this.databaseService.transaction(async (client) => {
      if (input.parent_account_id) {
        await this.requireAccount(client, companyId, input.parent_account_id);
      }
      try {
        const result = await this.databaseService.query(
          `
            INSERT INTO finance_accounts (company_id, code, name, account_type, description, parent_account_id)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING account_id, code, name, account_type, account_subtype, is_system, is_active, description, parent_account_id, created_at, updated_at
          `,
          [companyId, input.code, input.name, input.account_type, input.description ?? null, input.parent_account_id ?? null],
          client
        );
        return result.rows[0];
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw new ConflictException(`Account code ${input.code} is already in use.`);
        }
        throw error;
      }
    });
  }

  async updateAccount(
    companyId: string,
    accountId: string,
    input: Record<string, unknown>
  ) {
    return this.databaseService.transaction(async (client) => {
      const existing = await this.databaseService.query<{ is_system: boolean }>(
        `SELECT is_system FROM finance_accounts WHERE company_id = $1 AND account_id = $2`,
        [companyId, accountId],
        client
      );
      if (!existing.rows[0]) throw new NotFoundException("Account not found.");
      // System (hook) accounts can be renamed, deactivated, or deleted — only
      // their code is frozen, because it anchors the seed's ON CONFLICT and the
      // engine's self-heal re-creates a missing hook by (company, code).
      if (existing.rows[0].is_system && input.code !== undefined) {
        throw new BadRequestException("System accounts keep their code; you can still rename, deactivate, or delete them.");
      }
      if (input.parent_account_id) {
        if (input.parent_account_id === accountId) {
          throw new BadRequestException("An account cannot be its own parent.");
        }
        await this.requireAccount(client, companyId, input.parent_account_id as string);
      }

      const { clause, values } = buildUpdateClause(input, 3);
      if (!clause) throw new BadRequestException("Nothing to update.");
      try {
        const result = await this.databaseService.query(
          `
            UPDATE finance_accounts
            SET ${clause}, updated_at = NOW()
            WHERE company_id = $1 AND account_id = $2
            RETURNING account_id, code, name, account_type, account_subtype, is_system, is_active, description, parent_account_id, created_at, updated_at
          `,
          [companyId, accountId, ...values],
          client
        );
        return result.rows[0];
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw new ConflictException("That account code is already in use.");
        }
        throw error;
      }
    });
  }

  async deleteAccount(companyId: string, accountId: string) {
    return this.databaseService.transaction(async (client) => {
      const existing = await this.databaseService.query<{ is_system: boolean }>(
        `SELECT is_system FROM finance_accounts WHERE company_id = $1 AND account_id = $2`,
        [companyId, accountId],
        client
      );
      if (!existing.rows[0]) throw new NotFoundException("Account not found.");
      // Ledger history is append-only: an account that has ever been posted to
      // must stay so the audit trail keeps its references. Those get deactivated
      // rather than deleted. This applies to system and ordinary accounts alike.
      const used = await this.databaseService.query(
        `SELECT 1 FROM journal_lines WHERE company_id = $1 AND account_id = $2 LIMIT 1`,
        [companyId, accountId],
        client
      );
      if (used.rows.length > 0) {
        throw new ConflictException(
          "This account has ledger activity — deactivate it instead of deleting."
        );
      }
      // System (hook) accounts are deletable too; if a hook is later needed, the
      // posting engine re-seeds it on demand (see systemAccount).
      try {
        await this.databaseService.query(
          `DELETE FROM finance_accounts WHERE company_id = $1 AND account_id = $2`,
          [companyId, accountId],
          client
        );
      } catch (error) {
        if ((error as { code?: string }).code === "23503") {
          throw new ConflictException(
            "This account is referenced by a draft document — remove or repoint those lines first, or deactivate it."
          );
        }
        throw error;
      }
      return { deleted: true };
    });
  }

  // ── Vendors ───────────────────────────────────────────────────────────────

  async listVendors(companyId: string, query: z.infer<typeof listVendorsQuerySchema>) {
    const values: unknown[] = [companyId];
    const filters = ["company_id = $1"];
    if (query.is_active !== undefined) {
      values.push(query.is_active);
      filters.push(`is_active = $${values.length}`);
    }
    if (query.search) {
      values.push(`%${query.search}%`);
      filters.push(`(name ILIKE $${values.length} OR COALESCE(email, '') ILIKE $${values.length})`);
    }
    const result = await this.databaseService.query(
      `SELECT * FROM vendors WHERE ${filters.join(" AND ")} ORDER BY name`,
      values
    );
    return result.rows;
  }

  async createVendor(companyId: string, input: Record<string, unknown>) {
    const columns = ["name", "email", "phone", "tax_id", "address_line1", "address_line2", "city", "country_code", "notes"];
    const values: unknown[] = [companyId];
    const params = ["$1"];
    for (const col of columns) {
      values.push(input[col] ?? null);
      params.push(`$${values.length}`);
    }
    const result = await this.databaseService.query(
      `
        INSERT INTO vendors (company_id, ${columns.join(", ")})
        VALUES (${params.join(", ")})
        RETURNING *
      `,
      values
    );
    return result.rows[0];
  }

  async updateVendor(companyId: string, vendorId: string, input: Record<string, unknown>) {
    const { clause, values } = buildUpdateClause(input, 3);
    if (!clause) throw new BadRequestException("Nothing to update.");
    const result = await this.databaseService.query(
      `
        UPDATE vendors
        SET ${clause}, updated_at = NOW()
        WHERE company_id = $1 AND vendor_id = $2
        RETURNING *
      `,
      [companyId, vendorId, ...values]
    );
    if (!result.rows[0]) throw new NotFoundException("Vendor not found.");
    return result.rows[0];
  }

  async deleteVendor(companyId: string, vendorId: string) {
    const existing = await this.databaseService.query(
      `SELECT 1 FROM vendors WHERE company_id = $1 AND vendor_id = $2`,
      [companyId, vendorId]
    );
    if (!existing.rows[0]) throw new NotFoundException("Vendor not found.");
    // Bills/expenses/payments reference vendors with ON DELETE SET NULL, and
    // recurring_bills too — deleting a vendor detaches those documents (keeping
    // the snapshotted vendor_name) rather than blocking, so removal always works.
    await this.databaseService.query(
      `DELETE FROM vendors WHERE company_id = $1 AND vendor_id = $2`,
      [companyId, vendorId]
    );
    return { deleted: true };
  }

  // ── Recurring bills (routine costs: Rent, ...) ──────────────────────────────

  async listRecurringBills(companyId: string) {
    const result = await this.databaseService.query(
      `
        SELECT rb.recurring_bill_id, rb.name, rb.vendor_id, rb.vendor_name, rb.amount::text,
               rb.expense_account_id, a.name AS expense_account_name,
               rb.cadence, rb.day_of_month, rb.is_active, rb.notes, rb.last_posted_period,
               rb.created_at, rb.updated_at
        FROM recurring_bills rb
        LEFT JOIN finance_accounts a ON a.account_id = rb.expense_account_id
        WHERE rb.company_id = $1
        ORDER BY rb.is_active DESC, rb.name
      `,
      [companyId]
    );
    return result.rows;
  }

  async createRecurringBill(companyId: string, userId: string, input: CreateRecurringBillInput) {
    let vendorName = input.vendor_name ?? null;
    if (input.vendor_id) {
      const v = await this.databaseService.query<{ name: string }>(
        `SELECT name FROM vendors WHERE company_id = $1 AND vendor_id = $2`,
        [companyId, input.vendor_id]
      );
      vendorName = v.rows[0]?.name ?? vendorName;
    }
    if (input.expense_account_id) {
      const acct = await this.databaseService.query(
        `SELECT 1 FROM finance_accounts WHERE company_id = $1 AND account_id = $2`,
        [companyId, input.expense_account_id]
      );
      if (!acct.rows[0]) throw new NotFoundException("Expense account not found.");
    }
    const result = await this.databaseService.query<{ recurring_bill_id: string }>(
      `
        INSERT INTO recurring_bills
          (company_id, name, vendor_id, vendor_name, amount, expense_account_id, cadence, day_of_month, notes, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, 'monthly', $7, $8, $9)
        RETURNING recurring_bill_id
      `,
      [
        companyId,
        input.name,
        input.vendor_id ?? null,
        vendorName,
        input.amount,
        input.expense_account_id ?? null,
        input.day_of_month ?? null,
        input.notes ?? null,
        userId
      ]
    );
    return { recurring_bill_id: result.rows[0]!.recurring_bill_id };
  }

  async updateRecurringBill(companyId: string, recurringBillId: string, input: Record<string, unknown>) {
    const patch = { ...input };
    if (patch.vendor_id) {
      const v = await this.databaseService.query<{ name: string }>(
        `SELECT name FROM vendors WHERE company_id = $1 AND vendor_id = $2`,
        [companyId, patch.vendor_id]
      );
      if (v.rows[0]) patch.vendor_name = v.rows[0].name;
    }
    const { clause, values } = buildUpdateClause(patch, 3);
    if (!clause) throw new BadRequestException("Nothing to update.");
    const result = await this.databaseService.query(
      `
        UPDATE recurring_bills
        SET ${clause}, updated_at = NOW()
        WHERE company_id = $1 AND recurring_bill_id = $2
        RETURNING recurring_bill_id
      `,
      [companyId, recurringBillId, ...values]
    );
    if (!result.rows[0]) throw new NotFoundException("Recurring bill not found.");
    return result.rows[0];
  }

  async deleteRecurringBill(companyId: string, recurringBillId: string) {
    const result = await this.databaseService.query(
      `DELETE FROM recurring_bills WHERE company_id = $1 AND recurring_bill_id = $2`,
      [companyId, recurringBillId]
    );
    if (result.rowCount === 0) throw new NotFoundException("Recurring bill not found.");
    return { deleted: true };
  }

  // Generate a real DRAFT bill for the current month from a recurring template,
  // guarded so the same period is never double-posted.
  async postRecurringBill(companyId: string, userId: string, recurringBillId: string) {
    const tmpl = await this.databaseService.query<{
      name: string;
      vendor_id: string | null;
      vendor_name: string | null;
      amount: string;
      expense_account_id: string | null;
      is_active: boolean;
      last_posted_period: string | null;
    }>(
      `SELECT name, vendor_id, vendor_name, amount::text, expense_account_id, is_active, last_posted_period
       FROM recurring_bills WHERE company_id = $1 AND recurring_bill_id = $2`,
      [companyId, recurringBillId]
    );
    const row = tmpl.rows[0];
    if (!row) throw new NotFoundException("Recurring bill not found.");
    if (!row.is_active) throw new BadRequestException("This recurring bill is inactive.");

    const period = new Date().toISOString().slice(0, 7); // YYYY-MM
    if (row.last_posted_period === period) {
      throw new ConflictException(`${row.name} has already been posted for ${period}.`);
    }

    const created = await this.createBill(companyId, userId, {
      vendor_id: row.vendor_id ?? undefined,
      vendor_name: row.vendor_id ? undefined : row.vendor_name ?? row.name,
      lines: [
        {
          description: `${row.name} — ${period}`,
          quantity: 1,
          unit_price: Number(row.amount),
          account_id: row.expense_account_id ?? undefined
        }
      ]
    } as CreateBillInput);

    await this.databaseService.query(
      `UPDATE recurring_bills SET last_posted_period = $3, updated_at = NOW() WHERE company_id = $1 AND recurring_bill_id = $2`,
      [companyId, recurringBillId, period]
    );
    return created;
  }

  // ── Tax rates ─────────────────────────────────────────────────────────────

  async listTaxRates(companyId: string) {
    const result = await this.databaseService.query(
      `SELECT * FROM tax_rates WHERE company_id = $1 ORDER BY name`,
      [companyId]
    );
    return result.rows;
  }

  async createTaxRate(companyId: string, input: { name: string; rate_pct: number }) {
    try {
      const result = await this.databaseService.query(
        `
          INSERT INTO tax_rates (company_id, name, rate_pct)
          VALUES ($1, $2, $3)
          RETURNING *
        `,
        [companyId, input.name, input.rate_pct]
      );
      return result.rows[0];
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new ConflictException(`Tax rate "${input.name}" already exists.`);
      }
      throw error;
    }
  }

  async updateTaxRate(companyId: string, taxRateId: string, input: Record<string, unknown>) {
    const { clause, values } = buildUpdateClause(input, 3);
    if (!clause) throw new BadRequestException("Nothing to update.");
    const result = await this.databaseService.query(
      `
        UPDATE tax_rates
        SET ${clause}
        WHERE company_id = $1 AND tax_rate_id = $2
        RETURNING *
      `,
      [companyId, taxRateId, ...values]
    );
    if (!result.rows[0]) throw new NotFoundException("Tax rate not found.");
    return result.rows[0];
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  async getSettings(companyId: string) {
    const result = await this.databaseService.query(
      `
        INSERT INTO finance_settings (company_id)
        VALUES ($1)
        ON CONFLICT (company_id) DO UPDATE SET company_id = EXCLUDED.company_id
        RETURNING company_id, currency_code, lock_date::text, default_terms, default_tax_rate_id, updated_at
      `,
      [companyId]
    );
    return result.rows[0];
  }

  async updateSettings(
    companyId: string,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const { clause, values } = buildUpdateClause(input, 2);
    if (!clause) throw new BadRequestException("Nothing to update.");
    const result = await this.databaseService.query(
      `
        UPDATE finance_settings
        SET ${clause}, updated_at = NOW()
        WHERE company_id = $1
        RETURNING company_id, currency_code, lock_date::text, default_terms, default_tax_rate_id, updated_at
      `,
      [companyId, ...values]
    );
    if (!result.rows[0]) {
      await this.getSettings(companyId);
      return this.updateSettings(companyId, input);
    }
    return result.rows[0];
  }

  // ── Shared document-line machinery (invoices + bills) ────────────────────

  // Wipe and rewrite a document's lines, returning header totals in cents.
  // Line `amount` is a DB-generated column, so each insert reads the stored
  // amount back and derives tax from it — service and DB can never disagree.
  private async writeDocumentLines(
    client: PoolClient,
    companyId: string,
    doc: { table: "invoice_lines" | "bill_lines"; fkColumn: "invoice_id" | "bill_id"; accountColumn: "revenue_account_id" | "expense_account_id" },
    documentId: string,
    lines: DocumentLineInput[],
    accountTypes: string[]
  ): Promise<{ subtotal: number; taxTotal: number }> {
    await this.databaseService.query(
      `DELETE FROM ${doc.table} WHERE company_id = $1 AND ${doc.fkColumn} = $2`,
      [companyId, documentId],
      client
    );

    let subtotal = 0;
    let taxTotal = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;

      if (line.account_id) {
        await this.requireAccount(client, companyId, line.account_id, accountTypes);
      }

      let taxPct = 0;
      if (line.tax_rate_id) {
        const tax = await this.databaseService.query<{ rate_pct: string }>(
          `SELECT rate_pct FROM tax_rates WHERE company_id = $1 AND tax_rate_id = $2 AND is_active = TRUE`,
          [companyId, line.tax_rate_id],
          client
        );
        if (!tax.rows[0]) throw new NotFoundException("Tax rate not found or inactive.");
        taxPct = Number(tax.rows[0].rate_pct);
      }

      const inserted = await this.databaseService.query<{ line_id: string; amount: string }>(
        `
          INSERT INTO ${doc.table}
            (${doc.fkColumn}, company_id, description, quantity, unit_price, ${doc.accountColumn}, tax_rate_id, tax_pct, position)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          RETURNING line_id, amount
        `,
        [
          documentId,
          companyId,
          line.description,
          line.quantity,
          line.unit_price,
          line.account_id ?? null,
          line.tax_rate_id ?? null,
          taxPct,
          i
        ],
        client
      );

      const amountCents = cents(inserted.rows[0]!.amount);
      const taxCents = Math.round((amountCents * taxPct) / 100);
      if (taxCents > 0) {
        await this.databaseService.query(
          `UPDATE ${doc.table} SET tax_amount = $3 WHERE line_id = $1 AND company_id = $2`,
          [inserted.rows[0]!.line_id, companyId, fromCents(taxCents)],
          client
        );
      }
      subtotal += amountCents;
      taxTotal += taxCents;
    }

    return { subtotal, taxTotal };
  }

  // Snapshot a customer's display name so documents outlive CRM edits.
  private async customerDisplayName(
    client: PoolClient,
    companyId: string,
    customerId: string
  ): Promise<string> {
    const result = await this.databaseService.query<{ display_name: string }>(
      `
        SELECT COALESCE(NULLIF(business_name, ''), NULLIF(TRIM(concat_ws(' ', first_name, last_name)), ''), 'Customer') AS display_name
        FROM customers
        WHERE company_id = $1 AND customer_id = $2
      `,
      [companyId, customerId],
      client
    );
    if (!result.rows[0]) throw new NotFoundException("Customer not found.");
    return result.rows[0].display_name;
  }

  private async vendorDisplayName(
    client: PoolClient,
    companyId: string,
    vendorId: string
  ): Promise<string> {
    const result = await this.databaseService.query<{ name: string }>(
      `SELECT name FROM vendors WHERE company_id = $1 AND vendor_id = $2`,
      [companyId, vendorId],
      client
    );
    if (!result.rows[0]) throw new NotFoundException("Vendor not found.");
    return result.rows[0].name;
  }

  // ── Invoices (AR) ─────────────────────────────────────────────────────────

  private invoiceSelectSql() {
    return `
      SELECT
        i.invoice_id, i.company_id, i.invoice_number, i.customer_id,
        i.counterparty_name, i.order_id, i.status, i.issue_date::text,
        i.due_date::text, i.subtotal::text, i.tax_total::text, i.total::text,
        i.amount_paid::text, i.balance_due::text, i.memo, i.terms,
        i.journal_entry_id, i.created_at, i.updated_at,
        o.order_number
      FROM invoices i
      LEFT JOIN orders o ON o.order_id = i.order_id
    `;
  }

  async listInvoices(companyId: string, query: z.infer<typeof listInvoicesQuerySchema>) {
    const values: unknown[] = [companyId];
    const filters = ["i.company_id = $1"];
    if (query.status) {
      values.push(query.status);
      filters.push(`i.status = $${values.length}`);
    }
    if (query.customer_id) {
      values.push(query.customer_id);
      filters.push(`i.customer_id = $${values.length}`);
    }
    if (query.order_id) {
      values.push(query.order_id);
      filters.push(`i.order_id = $${values.length}`);
    }
    if (query.search) {
      values.push(`%${query.search}%`);
      filters.push(`(i.invoice_number ILIKE $${values.length} OR COALESCE(i.counterparty_name, '') ILIKE $${values.length})`);
    }
    const result = await this.databaseService.query(
      `
        ${this.invoiceSelectSql()}
        WHERE ${filters.join(" AND ")}
        ORDER BY i.issue_date DESC, i.created_at DESC
      `,
      values
    );
    return result.rows;
  }

  async getInvoice(companyId: string, invoiceId: string) {
    const invoice = await this.databaseService.query(
      `${this.invoiceSelectSql()} WHERE i.company_id = $1 AND i.invoice_id = $2`,
      [companyId, invoiceId]
    );
    if (!invoice.rows[0]) throw new NotFoundException("Invoice not found.");
    const lines = await this.databaseService.query(
      `
        SELECT line_id, description, quantity::text, unit_price::text, amount::text,
               revenue_account_id, tax_rate_id, tax_pct::text, tax_amount::text, position
        FROM invoice_lines
        WHERE company_id = $1 AND invoice_id = $2
        ORDER BY position
      `,
      [companyId, invoiceId]
    );
    const applications = await this.databaseService.query(
      `
        SELECT pa.application_id, pa.amount::text, pa.created_at,
               p.payment_id, p.payment_number, p.payment_date::text, p.method, p.status AS payment_status
        FROM payment_applications pa
        JOIN payments p ON p.payment_id = pa.payment_id
        WHERE pa.company_id = $1 AND pa.invoice_id = $2
        ORDER BY pa.created_at
      `,
      [companyId, invoiceId]
    );
    return { ...invoice.rows[0], lines: lines.rows, applications: applications.rows };
  }

  async createInvoice(companyId: string, userId: string, input: CreateInvoiceInput) {
    return this.databaseService.transaction(async (client) => {
      const issueDate = input.issue_date ?? this.today();
      const counterparty = input.customer_id
        ? await this.customerDisplayName(client, companyId, input.customer_id)
        : input.counterparty_name!;

      if (input.order_id) {
        const order = await this.databaseService.query(
          `SELECT 1 FROM orders WHERE company_id = $1 AND order_id = $2`,
          [companyId, input.order_id],
          client
        );
        if (!order.rows[0]) throw new NotFoundException("Order not found.");
      }

      const invoiceNumber = await this.nextDocNumber(client, companyId, "invoice", issueDate);
      const created = await this.databaseService.query<{ invoice_id: string }>(
        `
          INSERT INTO invoices
            (company_id, invoice_number, customer_id, counterparty_name, order_id, issue_date, due_date, memo, terms, created_by)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          RETURNING invoice_id
        `,
        [
          companyId,
          invoiceNumber,
          input.customer_id ?? null,
          counterparty,
          input.order_id ?? null,
          issueDate,
          input.due_date ?? null,
          input.memo ?? null,
          input.terms ?? null,
          userId
        ],
        client
      );
      const invoiceId = created.rows[0]!.invoice_id;

      const totals = await this.writeDocumentLines(
        client,
        companyId,
        { table: "invoice_lines", fkColumn: "invoice_id", accountColumn: "revenue_account_id" },
        invoiceId,
        input.lines,
        ["revenue"]
      );
      await this.databaseService.query(
        `UPDATE invoices SET subtotal = $3, tax_total = $4, total = $5, updated_at = NOW() WHERE company_id = $1 AND invoice_id = $2`,
        [companyId, invoiceId, fromCents(totals.subtotal), fromCents(totals.taxTotal), fromCents(totals.subtotal + totals.taxTotal)],
        client
      );

      return { invoice_id: invoiceId, invoice_number: invoiceNumber };
    });
  }

  // Drafts are freely editable; anything posted is not (void + reissue).
  async updateInvoice(companyId: string, invoiceId: string, input: UpdateInvoiceInput) {
    return this.databaseService.transaction(async (client) => {
      const existing = await this.databaseService.query<{ status: string }>(
        `SELECT status FROM invoices WHERE company_id = $1 AND invoice_id = $2 FOR UPDATE`,
        [companyId, invoiceId],
        client
      );
      if (!existing.rows[0]) throw new NotFoundException("Invoice not found.");
      if (existing.rows[0].status !== "draft") {
        throw new BadRequestException("Only draft invoices can be edited — void and reissue instead.");
      }

      const { lines, customer_id, ...headerInput } = input;
      const header: Record<string, unknown> = { ...headerInput };
      if (customer_id !== undefined) {
        header.customer_id = customer_id;
        if (customer_id) {
          header.counterparty_name = await this.customerDisplayName(client, companyId, customer_id);
        }
      }

      const { clause, values } = buildUpdateClause(header, 3);
      if (clause) {
        await this.databaseService.query(
          `UPDATE invoices SET ${clause}, updated_at = NOW() WHERE company_id = $1 AND invoice_id = $2`,
          [companyId, invoiceId, ...values],
          client
        );
      }

      if (lines) {
        const totals = await this.writeDocumentLines(
          client,
          companyId,
          { table: "invoice_lines", fkColumn: "invoice_id", accountColumn: "revenue_account_id" },
          invoiceId,
          lines,
          ["revenue"]
        );
        await this.databaseService.query(
          `UPDATE invoices SET subtotal = $3, tax_total = $4, total = $5, updated_at = NOW() WHERE company_id = $1 AND invoice_id = $2`,
          [companyId, invoiceId, fromCents(totals.subtotal), fromCents(totals.taxTotal), fromCents(totals.subtotal + totals.taxTotal)],
          client
        );
      }

      return this.getInvoice(companyId, invoiceId);
    });
  }

  // Issue = post to the ledger: DR A/R total, CR revenue per line account,
  // CR sales-tax payable. The invoice becomes collectible (open).
  async issueInvoice(companyId: string, userId: string, invoiceId: string) {
    return this.databaseService.transaction(async (client) => {
      const invoice = await this.databaseService.query<{
        status: string;
        invoice_number: string;
        issue_date: string;
        counterparty_name: string | null;
        order_id: string | null;
        total: string;
        tax_total: string;
      }>(
        `
          SELECT status, invoice_number, issue_date::text, counterparty_name, order_id, total, tax_total
          FROM invoices
          WHERE company_id = $1 AND invoice_id = $2
          FOR UPDATE
        `,
        [companyId, invoiceId],
        client
      );
      const row = invoice.rows[0];
      if (!row) throw new NotFoundException("Invoice not found.");
      if (row.status !== "draft") throw new BadRequestException("Only draft invoices can be issued.");
      if (cents(row.total) <= 0) throw new BadRequestException("Invoice total must be greater than zero.");

      const lines = await this.databaseService.query<{
        amount: string;
        revenue_account_id: string | null;
      }>(
        `SELECT amount, revenue_account_id FROM invoice_lines WHERE company_id = $1 AND invoice_id = $2`,
        [companyId, invoiceId],
        client
      );

      const arAccount = await this.systemAccount(client, companyId, "accounts_receivable");
      const defaultRevenue = await this.systemAccount(client, companyId, "sales");

      // Group line amounts by target revenue account.
      const byAccount = new Map<string, number>();
      for (const line of lines.rows) {
        const account = line.revenue_account_id ?? defaultRevenue;
        byAccount.set(account, (byAccount.get(account) ?? 0) + cents(line.amount));
      }

      const entryLines: JournalLineSpec[] = [
        {
          accountId: arAccount,
          debit: cents(row.total),
          credit: 0,
          description: `Invoice ${row.invoice_number} — ${row.counterparty_name ?? ""}`.trim()
        }
      ];
      for (const [accountId, amount] of byAccount) {
        if (amount > 0) entryLines.push({ accountId, debit: 0, credit: amount });
      }
      const taxCents = cents(row.tax_total);
      if (taxCents > 0) {
        const taxAccount = await this.systemAccount(client, companyId, "sales_tax_payable");
        entryLines.push({ accountId: taxAccount, debit: 0, credit: taxCents, description: "Sales tax" });
      }

      // COGS: an invoice generated from an order books the order's own cost as
      // cost of goods sold — DR COGS / CR Inventory for the order's base (pre-
      // profit) cost. The remainder of the sale (revenue − COGS) is the profit
      // margin, so the P&L reads correctly. Folded into THIS entry so voiding
      // the invoice reverses the COGS in the same reversal, and priced from the
      // shared costing service so it's the same cost the order actually shows.
      if (row.order_id) {
        const cost = await this.orderCosting.computeTotals(companyId, row.order_id, client);
        if (cost.priced && cost.baseCents > 0) {
          const cogsAccount = await this.systemAccount(client, companyId, "cogs");
          const inventoryAccount = await this.systemAccount(client, companyId, "inventory");
          entryLines.push({ accountId: cogsAccount, debit: cost.baseCents, credit: 0, description: "Cost of goods sold" });
          entryLines.push({ accountId: inventoryAccount, debit: 0, credit: cost.baseCents, description: "Inventory / production consumed" });
        }
      }

      const entry = await this.postEntry(client, companyId, userId, {
        entryDate: row.issue_date,
        memo: `Invoice ${row.invoice_number}`,
        sourceType: "invoice",
        sourceId: invoiceId,
        lines: entryLines
      });

      await this.databaseService.query(
        `UPDATE invoices SET status = 'open', journal_entry_id = $3, updated_at = NOW() WHERE company_id = $1 AND invoice_id = $2`,
        [companyId, invoiceId, entry.entry_id],
        client
      );

      return this.getInvoice(companyId, invoiceId);
    });
  }

  async voidInvoice(companyId: string, userId: string, invoiceId: string) {
    return this.databaseService.transaction(async (client) => {
      const invoice = await this.databaseService.query<{
        status: string;
        invoice_number: string;
        amount_paid: string;
        journal_entry_id: string | null;
      }>(
        `SELECT status, invoice_number, amount_paid, journal_entry_id FROM invoices WHERE company_id = $1 AND invoice_id = $2 FOR UPDATE`,
        [companyId, invoiceId],
        client
      );
      const row = invoice.rows[0];
      if (!row) throw new NotFoundException("Invoice not found.");
      if (row.status === "void") throw new BadRequestException("Invoice is already void.");
      if (cents(row.amount_paid) > 0) {
        throw new BadRequestException("Void the payments applied to this invoice first.");
      }

      if (row.status !== "draft" && row.journal_entry_id) {
        await this.postReversal(
          client,
          companyId,
          userId,
          row.journal_entry_id,
          `Void invoice ${row.invoice_number}`,
          invoiceId
        );
      }

      await this.databaseService.query(
        `UPDATE invoices SET status = 'void', updated_at = NOW() WHERE company_id = $1 AND invoice_id = $2`,
        [companyId, invoiceId],
        client
      );
      return this.getInvoice(companyId, invoiceId);
    });
  }

  // Generic ERP flow: draft an invoice straight from an order. The stored
  // per-piece cost rollup × profit% is the suggested price; the draft stays
  // fully editable before issue.
  async createInvoiceFromOrder(companyId: string, userId: string, orderId: string) {
    return this.databaseService.transaction(async (client) => {
      const order = await this.databaseService.query<{
        order_id: string;
        order_number: string;
        title: string;
        customer_id: string | null;
        guest_name: string | null;
      }>(
        `
          SELECT o.order_id, o.order_number, o.title, o.customer_id, o.guest_name
          FROM orders o
          WHERE o.company_id = $1 AND o.order_id = $2
        `,
        [companyId, orderId],
        client
      );
      const row = order.rows[0];
      if (!row) throw new NotFoundException("Order not found.");

      const existing = await this.databaseService.query<{ invoice_number: string }>(
        `SELECT invoice_number FROM invoices WHERE company_id = $1 AND order_id = $2 AND status <> 'void' LIMIT 1`,
        [companyId, orderId],
        client
      );
      if (existing.rows[0]) {
        throw new ConflictException(
          `Order ${row.order_number} is already invoiced (${existing.rows[0].invoice_number}).`
        );
      }

      // Price the order EXACTLY as the Orders UI shows it: live per-piece cost
      // × (1 + profit%). Using the shared costing service (not a re-derivation
      // from stale SUM(order_pieces.cost)) is what keeps the invoice subtotal
      // equal to the total the customer was quoted. totalCents is the sell
      // price; baseCents is the COGS booked at issue time.
      const totals = await this.orderCosting.computeTotals(companyId, orderId, client);
      if (!totals.priced || totals.totalCents <= 0) {
        throw new BadRequestException(
          "This order has no priced pieces yet, so there is nothing to invoice."
        );
      }

      const issueDate = this.today();
      const counterparty = row.customer_id
        ? await this.customerDisplayName(client, companyId, row.customer_id)
        : row.guest_name ?? "Customer";

      // Pre-fill the company default tax rate; a stale/inactive default falls
      // back to no tax (the join drops it) rather than erroring the whole flow.
      const taxDefault = await this.databaseService.query<{ tax_rate_id: string | null }>(
        `
          SELECT tr.tax_rate_id
          FROM finance_settings fs
          LEFT JOIN tax_rates tr
            ON tr.tax_rate_id = fs.default_tax_rate_id AND tr.company_id = fs.company_id AND tr.is_active
          WHERE fs.company_id = $1
        `,
        [companyId],
        client
      );
      const defaultTaxRateId = taxDefault.rows[0]?.tax_rate_id ?? undefined;

      const invoiceNumber = await this.nextDocNumber(client, companyId, "invoice", issueDate);
      const created = await this.databaseService.query<{ invoice_id: string }>(
        `
          INSERT INTO invoices
            (company_id, invoice_number, customer_id, counterparty_name, order_id, issue_date, memo, created_by)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING invoice_id
        `,
        [
          companyId,
          invoiceNumber,
          row.customer_id,
          counterparty,
          orderId,
          issueDate,
          `Generated from order ${row.order_number}`,
          userId
        ],
        client
      );
      const invoiceId = created.rows[0]!.invoice_id;

      // One line at the full quoted price. Subtotal therefore equals the order's
      // displayed total exactly (before tax); tax is added on top.
      const lineTotals = await this.writeDocumentLines(
        client,
        companyId,
        { table: "invoice_lines", fkColumn: "invoice_id", accountColumn: "revenue_account_id" },
        invoiceId,
        [
          {
            description: `Order ${row.order_number} — ${row.title}`,
            quantity: 1,
            unit_price: fromCents(totals.totalCents),
            tax_rate_id: defaultTaxRateId
          }
        ],
        ["revenue"]
      );
      await this.databaseService.query(
        `UPDATE invoices SET subtotal = $3, tax_total = $4, total = $5, updated_at = NOW() WHERE company_id = $1 AND invoice_id = $2`,
        [companyId, invoiceId, fromCents(lineTotals.subtotal), fromCents(lineTotals.taxTotal), fromCents(lineTotals.subtotal + lineTotals.taxTotal)],
        client
      );

      return { invoice_id: invoiceId, invoice_number: invoiceNumber };
    });
  }

  // ── Bills (AP) ────────────────────────────────────────────────────────────

  private billSelectSql() {
    return `
      SELECT
        b.bill_id, b.company_id, b.bill_number, b.vendor_reference, b.vendor_id,
        b.vendor_name, b.status, b.issue_date::text, b.due_date::text,
        b.subtotal::text, b.tax_total::text, b.total::text, b.amount_paid::text,
        b.balance_due::text, b.memo, b.journal_entry_id, b.created_at, b.updated_at
      FROM bills b
    `;
  }

  async listBills(companyId: string, query: z.infer<typeof listBillsQuerySchema>) {
    const values: unknown[] = [companyId];
    const filters = ["b.company_id = $1"];
    if (query.status) {
      values.push(query.status);
      filters.push(`b.status = $${values.length}`);
    }
    if (query.vendor_id) {
      values.push(query.vendor_id);
      filters.push(`b.vendor_id = $${values.length}`);
    }
    if (query.search) {
      values.push(`%${query.search}%`);
      filters.push(`(b.bill_number ILIKE $${values.length} OR COALESCE(b.vendor_name, '') ILIKE $${values.length} OR COALESCE(b.vendor_reference, '') ILIKE $${values.length})`);
    }
    const result = await this.databaseService.query(
      `${this.billSelectSql()} WHERE ${filters.join(" AND ")} ORDER BY b.issue_date DESC, b.created_at DESC`,
      values
    );
    return result.rows;
  }

  async getBill(companyId: string, billId: string) {
    const bill = await this.databaseService.query(
      `${this.billSelectSql()} WHERE b.company_id = $1 AND b.bill_id = $2`,
      [companyId, billId]
    );
    if (!bill.rows[0]) throw new NotFoundException("Bill not found.");
    const lines = await this.databaseService.query(
      `
        SELECT line_id, description, quantity::text, unit_price::text, amount::text,
               expense_account_id, tax_rate_id, tax_pct::text, tax_amount::text, position
        FROM bill_lines
        WHERE company_id = $1 AND bill_id = $2
        ORDER BY position
      `,
      [companyId, billId]
    );
    const applications = await this.databaseService.query(
      `
        SELECT pa.application_id, pa.amount::text, pa.created_at,
               p.payment_id, p.payment_number, p.payment_date::text, p.method, p.status AS payment_status
        FROM payment_applications pa
        JOIN payments p ON p.payment_id = pa.payment_id
        WHERE pa.company_id = $1 AND pa.bill_id = $2
        ORDER BY pa.created_at
      `,
      [companyId, billId]
    );
    return { ...bill.rows[0], lines: lines.rows, applications: applications.rows };
  }

  async createBill(companyId: string, userId: string, input: CreateBillInput) {
    return this.databaseService.transaction(async (client) => {
      const issueDate = input.issue_date ?? this.today();
      const vendorName = input.vendor_id
        ? await this.vendorDisplayName(client, companyId, input.vendor_id)
        : input.vendor_name!;

      const billNumber = await this.nextDocNumber(client, companyId, "bill", issueDate);
      const created = await this.databaseService.query<{ bill_id: string }>(
        `
          INSERT INTO bills
            (company_id, bill_number, vendor_reference, vendor_id, vendor_name, issue_date, due_date, memo, created_by)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          RETURNING bill_id
        `,
        [
          companyId,
          billNumber,
          input.vendor_reference ?? null,
          input.vendor_id ?? null,
          vendorName,
          issueDate,
          input.due_date ?? null,
          input.memo ?? null,
          userId
        ],
        client
      );
      const billId = created.rows[0]!.bill_id;

      const totals = await this.writeDocumentLines(
        client,
        companyId,
        { table: "bill_lines", fkColumn: "bill_id", accountColumn: "expense_account_id" },
        billId,
        input.lines,
        ["expense", "asset"]
      );
      await this.databaseService.query(
        `UPDATE bills SET subtotal = $3, tax_total = $4, total = $5, updated_at = NOW() WHERE company_id = $1 AND bill_id = $2`,
        [companyId, billId, fromCents(totals.subtotal), fromCents(totals.taxTotal), fromCents(totals.subtotal + totals.taxTotal)],
        client
      );

      return { bill_id: billId, bill_number: billNumber };
    });
  }

  async updateBill(companyId: string, billId: string, input: UpdateBillInput) {
    return this.databaseService.transaction(async (client) => {
      const existing = await this.databaseService.query<{ status: string }>(
        `SELECT status FROM bills WHERE company_id = $1 AND bill_id = $2 FOR UPDATE`,
        [companyId, billId],
        client
      );
      if (!existing.rows[0]) throw new NotFoundException("Bill not found.");
      if (existing.rows[0].status !== "draft") {
        throw new BadRequestException("Only draft bills can be edited — void and re-enter instead.");
      }

      const { lines, vendor_id, ...headerInput } = input;
      const header: Record<string, unknown> = { ...headerInput };
      if (vendor_id !== undefined) {
        header.vendor_id = vendor_id;
        if (vendor_id) {
          header.vendor_name = await this.vendorDisplayName(client, companyId, vendor_id);
        }
      }

      const { clause, values } = buildUpdateClause(header, 3);
      if (clause) {
        await this.databaseService.query(
          `UPDATE bills SET ${clause}, updated_at = NOW() WHERE company_id = $1 AND bill_id = $2`,
          [companyId, billId, ...values],
          client
        );
      }

      if (lines) {
        const totals = await this.writeDocumentLines(
          client,
          companyId,
          { table: "bill_lines", fkColumn: "bill_id", accountColumn: "expense_account_id" },
          billId,
          lines,
          ["expense", "asset"]
        );
        await this.databaseService.query(
          `UPDATE bills SET subtotal = $3, tax_total = $4, total = $5, updated_at = NOW() WHERE company_id = $1 AND bill_id = $2`,
          [companyId, billId, fromCents(totals.subtotal), fromCents(totals.taxTotal), fromCents(totals.subtotal + totals.taxTotal)],
          client
        );
      }

      return this.getBill(companyId, billId);
    });
  }

  // Open = post to the ledger: DR expense per line account (+ input tax),
  // CR A/P total. The bill becomes payable.
  async openBill(companyId: string, userId: string, billId: string) {
    return this.databaseService.transaction(async (client) => {
      const bill = await this.databaseService.query<{
        status: string;
        bill_number: string;
        issue_date: string;
        vendor_name: string | null;
        total: string;
        tax_total: string;
      }>(
        `SELECT status, bill_number, issue_date::text, vendor_name, total, tax_total FROM bills WHERE company_id = $1 AND bill_id = $2 FOR UPDATE`,
        [companyId, billId],
        client
      );
      const row = bill.rows[0];
      if (!row) throw new NotFoundException("Bill not found.");
      if (row.status !== "draft") throw new BadRequestException("Only draft bills can be opened.");
      if (cents(row.total) <= 0) throw new BadRequestException("Bill total must be greater than zero.");

      const lines = await this.databaseService.query<{
        amount: string;
        expense_account_id: string | null;
      }>(
        `SELECT amount, expense_account_id FROM bill_lines WHERE company_id = $1 AND bill_id = $2`,
        [companyId, billId],
        client
      );

      const apAccount = await this.systemAccount(client, companyId, "accounts_payable");
      const defaultExpense = await this.systemAccount(client, companyId, "operating_expenses");

      const byAccount = new Map<string, number>();
      for (const line of lines.rows) {
        const account = line.expense_account_id ?? defaultExpense;
        byAccount.set(account, (byAccount.get(account) ?? 0) + cents(line.amount));
      }

      const entryLines: JournalLineSpec[] = [];
      for (const [accountId, amount] of byAccount) {
        if (amount > 0) entryLines.push({ accountId, debit: amount, credit: 0 });
      }
      const taxCents = cents(row.tax_total);
      if (taxCents > 0) {
        const taxAccount = await this.systemAccount(client, companyId, "input_tax_receivable");
        entryLines.push({ accountId: taxAccount, debit: taxCents, credit: 0, description: "Input tax" });
      }
      entryLines.push({
        accountId: apAccount,
        debit: 0,
        credit: cents(row.total),
        description: `Bill ${row.bill_number} — ${row.vendor_name ?? ""}`.trim()
      });

      const entry = await this.postEntry(client, companyId, userId, {
        entryDate: row.issue_date,
        memo: `Bill ${row.bill_number}`,
        sourceType: "bill",
        sourceId: billId,
        lines: entryLines
      });

      await this.databaseService.query(
        `UPDATE bills SET status = 'open', journal_entry_id = $3, updated_at = NOW() WHERE company_id = $1 AND bill_id = $2`,
        [companyId, billId, entry.entry_id],
        client
      );

      return this.getBill(companyId, billId);
    });
  }

  async voidBill(companyId: string, userId: string, billId: string) {
    return this.databaseService.transaction(async (client) => {
      const bill = await this.databaseService.query<{
        status: string;
        bill_number: string;
        amount_paid: string;
        journal_entry_id: string | null;
      }>(
        `SELECT status, bill_number, amount_paid, journal_entry_id FROM bills WHERE company_id = $1 AND bill_id = $2 FOR UPDATE`,
        [companyId, billId],
        client
      );
      const row = bill.rows[0];
      if (!row) throw new NotFoundException("Bill not found.");
      if (row.status === "void") throw new BadRequestException("Bill is already void.");
      if (cents(row.amount_paid) > 0) {
        throw new BadRequestException("Void the payments applied to this bill first.");
      }

      if (row.status !== "draft" && row.journal_entry_id) {
        await this.postReversal(client, companyId, userId, row.journal_entry_id, `Void bill ${row.bill_number}`, billId);
      }

      await this.databaseService.query(
        `UPDATE bills SET status = 'void', updated_at = NOW() WHERE company_id = $1 AND bill_id = $2`,
        [companyId, billId],
        client
      );
      return this.getBill(companyId, billId);
    });
  }

  // ── Payments ──────────────────────────────────────────────────────────────

  async listPayments(companyId: string, query: z.infer<typeof listPaymentsQuerySchema>) {
    const values: unknown[] = [companyId];
    const filters = ["p.company_id = $1"];
    if (query.direction) {
      values.push(query.direction);
      filters.push(`p.direction = $${values.length}`);
    }
    if (query.status) {
      values.push(query.status);
      filters.push(`p.status = $${values.length}`);
    }
    if (query.search) {
      values.push(`%${query.search}%`);
      filters.push(`(p.payment_number ILIKE $${values.length} OR COALESCE(p.counterparty_name, '') ILIKE $${values.length} OR COALESCE(p.reference, '') ILIKE $${values.length})`);
    }
    const result = await this.databaseService.query(
      `
        SELECT
          p.payment_id, p.payment_number, p.direction, p.method,
          p.payment_date::text, p.amount::text, p.deposit_account_id,
          a.name AS deposit_account_name,
          p.customer_id, p.vendor_id, p.counterparty_name, p.reference, p.memo,
          p.status, p.journal_entry_id, p.created_at,
          COALESCE(SUM(pa.amount), 0)::text AS applied_total,
          COUNT(pa.application_id)::int AS application_count
        FROM payments p
        JOIN finance_accounts a ON a.account_id = p.deposit_account_id
        LEFT JOIN payment_applications pa ON pa.payment_id = p.payment_id
        WHERE ${filters.join(" AND ")}
        GROUP BY p.payment_id, a.name
        ORDER BY p.payment_date DESC, p.created_at DESC
      `,
      values
    );
    return result.rows;
  }

  async createPayment(companyId: string, userId: string, input: CreatePaymentInput) {
    return this.databaseService.transaction(async (client) => {
      const paymentDate = input.payment_date ?? this.today();
      const amountCents = cents(input.amount);

      await this.requireAccount(client, companyId, input.deposit_account_id, ["asset"]);

      const appliedTotal = input.applications.reduce((s, a) => s + cents(a.amount), 0);
      if (appliedTotal > amountCents) {
        throw new BadRequestException("Applied total exceeds the payment amount.");
      }

      let counterparty = input.counterparty_name ?? null;
      if (!counterparty && input.customer_id) {
        counterparty = await this.customerDisplayName(client, companyId, input.customer_id);
      }
      if (!counterparty && input.vendor_id) {
        counterparty = await this.vendorDisplayName(client, companyId, input.vendor_id);
      }

      // Settle each document under a row lock, so two concurrent payments
      // cannot overpay the same invoice/bill.
      for (const app of input.applications) {
        const appCents = cents(app.amount);
        if (input.direction === "in") {
          if (!app.invoice_id) throw new BadRequestException("Money-in payments settle invoices.");
          const invoice = await this.databaseService.query<{ total: string; amount_paid: string; status: string }>(
            `SELECT total, amount_paid, status FROM invoices WHERE company_id = $1 AND invoice_id = $2 FOR UPDATE`,
            [companyId, app.invoice_id],
            client
          );
          const inv = invoice.rows[0];
          if (!inv) throw new NotFoundException("Invoice not found.");
          if (!["open", "partial"].includes(inv.status)) {
            throw new BadRequestException("Payments can only be applied to open invoices.");
          }
          const due = cents(inv.total) - cents(inv.amount_paid);
          if (appCents > due) {
            throw new BadRequestException("Application exceeds the invoice balance due.");
          }
          const newPaid = cents(inv.amount_paid) + appCents;
          await this.databaseService.query(
            `UPDATE invoices SET amount_paid = $3, status = $4, updated_at = NOW() WHERE company_id = $1 AND invoice_id = $2`,
            [companyId, app.invoice_id, fromCents(newPaid), newPaid >= cents(inv.total) ? "paid" : "partial"],
            client
          );
        } else {
          if (!app.bill_id) throw new BadRequestException("Money-out payments settle bills.");
          const bill = await this.databaseService.query<{ total: string; amount_paid: string; status: string }>(
            `SELECT total, amount_paid, status FROM bills WHERE company_id = $1 AND bill_id = $2 FOR UPDATE`,
            [companyId, app.bill_id],
            client
          );
          const b = bill.rows[0];
          if (!b) throw new NotFoundException("Bill not found.");
          if (!["open", "partial"].includes(b.status)) {
            throw new BadRequestException("Payments can only be applied to open bills.");
          }
          const due = cents(b.total) - cents(b.amount_paid);
          if (appCents > due) {
            throw new BadRequestException("Application exceeds the bill balance due.");
          }
          const newPaid = cents(b.amount_paid) + appCents;
          await this.databaseService.query(
            `UPDATE bills SET amount_paid = $3, status = $4, updated_at = NOW() WHERE company_id = $1 AND bill_id = $2`,
            [companyId, app.bill_id, fromCents(newPaid), newPaid >= cents(b.total) ? "paid" : "partial"],
            client
          );
        }
      }

      // The ledger entry. Unapplied remainder parks in customer credits /
      // vendor prepayments so the entry always balances.
      const remainder = amountCents - appliedTotal;
      const entryLines: JournalLineSpec[] = [];
      if (input.direction === "in") {
        entryLines.push({ accountId: input.deposit_account_id, debit: amountCents, credit: 0 });
        if (appliedTotal > 0) {
          const ar = await this.systemAccount(client, companyId, "accounts_receivable");
          entryLines.push({ accountId: ar, debit: 0, credit: appliedTotal, description: "Invoice settlement" });
        }
        if (remainder > 0) {
          const creditsAccount = await this.systemAccount(client, companyId, "customer_credits");
          entryLines.push({ accountId: creditsAccount, debit: 0, credit: remainder, description: "Unapplied receipt" });
        }
      } else {
        if (appliedTotal > 0) {
          const ap = await this.systemAccount(client, companyId, "accounts_payable");
          entryLines.push({ accountId: ap, debit: appliedTotal, credit: 0, description: "Bill settlement" });
        }
        if (remainder > 0) {
          const prepay = await this.systemAccount(client, companyId, "vendor_prepayments");
          entryLines.push({ accountId: prepay, debit: remainder, credit: 0, description: "Unapplied disbursement" });
        }
        entryLines.push({ accountId: input.deposit_account_id, debit: 0, credit: amountCents });
      }

      const paymentNumber = await this.nextDocNumber(client, companyId, "payment", paymentDate);
      const created = await this.databaseService.query<{ payment_id: string }>(
        `
          INSERT INTO payments
            (company_id, payment_number, direction, method, payment_date, amount, deposit_account_id,
             customer_id, vendor_id, counterparty_name, reference, memo, created_by)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          RETURNING payment_id
        `,
        [
          companyId,
          paymentNumber,
          input.direction,
          input.method,
          paymentDate,
          fromCents(amountCents),
          input.deposit_account_id,
          input.customer_id ?? null,
          input.vendor_id ?? null,
          counterparty,
          input.reference ?? null,
          input.memo ?? null,
          userId
        ],
        client
      );
      const paymentId = created.rows[0]!.payment_id;

      for (const app of input.applications) {
        await this.databaseService.query(
          `
            INSERT INTO payment_applications (company_id, payment_id, invoice_id, bill_id, amount)
            VALUES ($1, $2, $3, $4, $5)
          `,
          [companyId, paymentId, app.invoice_id ?? null, app.bill_id ?? null, fromCents(cents(app.amount))],
          client
        );
      }

      const entry = await this.postEntry(client, companyId, userId, {
        entryDate: paymentDate,
        memo: `Payment ${paymentNumber}${counterparty ? ` — ${counterparty}` : ""}`,
        sourceType: "payment",
        sourceId: paymentId,
        lines: entryLines
      });
      await this.databaseService.query(
        `UPDATE payments SET journal_entry_id = $3 WHERE company_id = $1 AND payment_id = $2`,
        [companyId, paymentId, entry.entry_id],
        client
      );

      return { payment_id: paymentId, payment_number: paymentNumber };
    });
  }

  async voidPayment(companyId: string, userId: string, paymentId: string) {
    return this.databaseService.transaction(async (client) => {
      const payment = await this.databaseService.query<{
        status: string;
        payment_number: string;
        journal_entry_id: string | null;
      }>(
        `SELECT status, payment_number, journal_entry_id FROM payments WHERE company_id = $1 AND payment_id = $2 FOR UPDATE`,
        [companyId, paymentId],
        client
      );
      const row = payment.rows[0];
      if (!row) throw new NotFoundException("Payment not found.");
      if (row.status === "void") throw new BadRequestException("Payment is already void.");

      // Give back every settlement, restoring each document's paid/partial/open state.
      const applications = await this.databaseService.query<{
        invoice_id: string | null;
        bill_id: string | null;
        amount: string;
      }>(
        `SELECT invoice_id, bill_id, amount FROM payment_applications WHERE company_id = $1 AND payment_id = $2`,
        [companyId, paymentId],
        client
      );
      for (const app of applications.rows) {
        const appCents = cents(app.amount);
        if (app.invoice_id) {
          const invoice = await this.databaseService.query<{ amount_paid: string }>(
            `SELECT amount_paid FROM invoices WHERE company_id = $1 AND invoice_id = $2 FOR UPDATE`,
            [companyId, app.invoice_id],
            client
          );
          if (invoice.rows[0]) {
            const newPaid = Math.max(0, cents(invoice.rows[0].amount_paid) - appCents);
            await this.databaseService.query(
              `UPDATE invoices SET amount_paid = $3, status = $4, updated_at = NOW() WHERE company_id = $1 AND invoice_id = $2 AND status <> 'void'`,
              [companyId, app.invoice_id, fromCents(newPaid), newPaid === 0 ? "open" : "partial"],
              client
            );
          }
        } else if (app.bill_id) {
          const bill = await this.databaseService.query<{ amount_paid: string }>(
            `SELECT amount_paid FROM bills WHERE company_id = $1 AND bill_id = $2 FOR UPDATE`,
            [companyId, app.bill_id],
            client
          );
          if (bill.rows[0]) {
            const newPaid = Math.max(0, cents(bill.rows[0].amount_paid) - appCents);
            await this.databaseService.query(
              `UPDATE bills SET amount_paid = $3, status = $4, updated_at = NOW() WHERE company_id = $1 AND bill_id = $2 AND status <> 'void'`,
              [companyId, app.bill_id, fromCents(newPaid), newPaid === 0 ? "open" : "partial"],
              client
            );
          }
        }
      }

      if (row.journal_entry_id) {
        await this.postReversal(client, companyId, userId, row.journal_entry_id, `Void payment ${row.payment_number}`, paymentId);
      }

      await this.databaseService.query(
        `UPDATE payments SET status = 'void', updated_at = NOW() WHERE company_id = $1 AND payment_id = $2`,
        [companyId, paymentId],
        client
      );
      return { voided: true };
    });
  }

  // ── Expenses ──────────────────────────────────────────────────────────────

  async listExpenses(companyId: string, query: z.infer<typeof listExpensesQuerySchema>) {
    const values: unknown[] = [companyId];
    const filters = ["e.company_id = $1"];
    if (query.status) {
      values.push(query.status);
      filters.push(`e.status = $${values.length}`);
    }
    if (query.search) {
      values.push(`%${query.search}%`);
      filters.push(`(e.expense_number ILIKE $${values.length} OR COALESCE(e.vendor_name, '') ILIKE $${values.length} OR COALESCE(e.description, '') ILIKE $${values.length})`);
    }
    const result = await this.databaseService.query(
      `
        SELECT
          e.expense_id, e.expense_number, e.vendor_id, e.vendor_name,
          e.expense_date::text, e.amount::text, e.category_account_id,
          ca.name AS category_account_name,
          e.paid_from_account_id, pa.name AS paid_from_account_name,
          e.description, e.reference, e.status, e.journal_entry_id, e.created_at
        FROM expenses e
        JOIN finance_accounts ca ON ca.account_id = e.category_account_id
        JOIN finance_accounts pa ON pa.account_id = e.paid_from_account_id
        WHERE ${filters.join(" AND ")}
        ORDER BY e.expense_date DESC, e.created_at DESC
      `,
      values
    );
    return result.rows;
  }

  async createExpense(companyId: string, userId: string, input: CreateExpenseInput) {
    return this.databaseService.transaction(async (client) => {
      const expenseDate = input.expense_date ?? this.today();
      const amountCents = cents(input.amount);

      await this.requireAccount(client, companyId, input.category_account_id, ["expense", "asset"]);
      await this.requireAccount(client, companyId, input.paid_from_account_id, ["asset"]);
      if (input.category_account_id === input.paid_from_account_id) {
        throw new BadRequestException("Category and paying account must differ.");
      }

      let vendorName = input.vendor_name ?? null;
      if (!vendorName && input.vendor_id) {
        vendorName = await this.vendorDisplayName(client, companyId, input.vendor_id);
      }

      const expenseNumber = await this.nextDocNumber(client, companyId, "expense", expenseDate);
      const created = await this.databaseService.query<{ expense_id: string }>(
        `
          INSERT INTO expenses
            (company_id, expense_number, vendor_id, vendor_name, expense_date, amount,
             category_account_id, paid_from_account_id, description, reference, created_by)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          RETURNING expense_id
        `,
        [
          companyId,
          expenseNumber,
          input.vendor_id ?? null,
          vendorName,
          expenseDate,
          fromCents(amountCents),
          input.category_account_id,
          input.paid_from_account_id,
          input.description ?? null,
          input.reference ?? null,
          userId
        ],
        client
      );
      const expenseId = created.rows[0]!.expense_id;

      const entry = await this.postEntry(client, companyId, userId, {
        entryDate: expenseDate,
        memo: `Expense ${expenseNumber}${vendorName ? ` — ${vendorName}` : ""}`,
        sourceType: "expense",
        sourceId: expenseId,
        lines: [
          { accountId: input.category_account_id, debit: amountCents, credit: 0, description: input.description ?? null },
          { accountId: input.paid_from_account_id, debit: 0, credit: amountCents }
        ]
      });
      await this.databaseService.query(
        `UPDATE expenses SET journal_entry_id = $3 WHERE company_id = $1 AND expense_id = $2`,
        [companyId, expenseId, entry.entry_id],
        client
      );

      return { expense_id: expenseId, expense_number: expenseNumber };
    });
  }

  async voidExpense(companyId: string, userId: string, expenseId: string) {
    return this.databaseService.transaction(async (client) => {
      const expense = await this.databaseService.query<{
        status: string;
        expense_number: string;
        journal_entry_id: string | null;
      }>(
        `SELECT status, expense_number, journal_entry_id FROM expenses WHERE company_id = $1 AND expense_id = $2 FOR UPDATE`,
        [companyId, expenseId],
        client
      );
      const row = expense.rows[0];
      if (!row) throw new NotFoundException("Expense not found.");
      if (row.status === "void") throw new BadRequestException("Expense is already void.");

      if (row.journal_entry_id) {
        await this.postReversal(client, companyId, userId, row.journal_entry_id, `Void expense ${row.expense_number}`, expenseId);
      }
      await this.databaseService.query(
        `UPDATE expenses SET status = 'void', updated_at = NOW() WHERE company_id = $1 AND expense_id = $2`,
        [companyId, expenseId],
        client
      );
      return { voided: true };
    });
  }

  // ── Journal ───────────────────────────────────────────────────────────────

  async listJournal(companyId: string, query: z.infer<typeof listJournalQuerySchema>) {
    const values: unknown[] = [companyId];
    const filters = ["e.company_id = $1"];
    if (query.from) {
      values.push(query.from);
      filters.push(`e.entry_date >= $${values.length}`);
    }
    if (query.to) {
      values.push(query.to);
      filters.push(`e.entry_date <= $${values.length}`);
    }
    if (query.source_type) {
      values.push(query.source_type);
      filters.push(`e.source_type = $${values.length}`);
    }
    if (query.account_id) {
      values.push(query.account_id);
      filters.push(`EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.entry_id = e.entry_id AND jl.account_id = $${values.length})`);
    }
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    values.push(limit, offset);

    const result = await this.databaseService.query(
      `
        SELECT
          e.entry_id, e.entry_number, e.entry_date::text, e.memo, e.status,
          e.source_type, e.source_id, e.reverses_entry_id, e.posted_at, e.created_at,
          COALESCE(SUM(l.debit), 0)::text AS total_debit,
          COUNT(l.line_id)::int AS line_count
        FROM journal_entries e
        LEFT JOIN journal_lines l ON l.entry_id = e.entry_id
        WHERE ${filters.join(" AND ")}
        GROUP BY e.entry_id
        ORDER BY e.entry_date DESC, e.created_at DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}
      `,
      values
    );
    return result.rows;
  }

  async getJournalEntry(companyId: string, entryId: string) {
    const entry = await this.databaseService.query(
      `
        SELECT entry_id, entry_number, entry_date::text, memo, status, source_type,
               source_id, reverses_entry_id, posted_at, created_at
        FROM journal_entries
        WHERE company_id = $1 AND entry_id = $2
      `,
      [companyId, entryId]
    );
    if (!entry.rows[0]) throw new NotFoundException("Journal entry not found.");
    const lines = await this.databaseService.query(
      `
        SELECT l.line_id, l.account_id, a.code AS account_code, a.name AS account_name,
               l.debit::text, l.credit::text, l.description, l.position
        FROM journal_lines l
        JOIN finance_accounts a ON a.account_id = l.account_id
        WHERE l.company_id = $1 AND l.entry_id = $2
        ORDER BY l.position
      `,
      [companyId, entryId]
    );
    return { ...entry.rows[0], lines: lines.rows };
  }

  async createManualEntry(companyId: string, userId: string, input: CreateJournalEntryInput) {
    return this.databaseService.transaction(async (client) => {
      for (const line of input.lines) {
        await this.requireAccount(client, companyId, line.account_id);
      }
      const entry = await this.postEntry(client, companyId, userId, {
        entryDate: input.entry_date ?? this.today(),
        memo: input.memo ?? null,
        sourceType: "manual",
        lines: input.lines.map((l) => ({
          accountId: l.account_id,
          debit: cents(l.debit),
          credit: cents(l.credit),
          description: l.description ?? null
        }))
      });
      return this.getJournalEntry(companyId, entry.entry_id);
    });
  }

  // Per-account ledger: running statement of one account's posted activity.
  async accountLedger(
    companyId: string,
    accountId: string,
    query: z.infer<typeof ledgerQuerySchema>
  ) {
    const account = await this.databaseService.query(
      `SELECT account_id, code, name, account_type FROM finance_accounts WHERE company_id = $1 AND account_id = $2`,
      [companyId, accountId]
    );
    if (!account.rows[0]) throw new NotFoundException("Account not found.");

    const values: unknown[] = [companyId, accountId];
    const filters = ["l.company_id = $1", "l.account_id = $2", "e.status = 'posted'"];
    if (query.from) {
      values.push(query.from);
      filters.push(`e.entry_date >= $${values.length}`);
    }
    if (query.to) {
      values.push(query.to);
      filters.push(`e.entry_date <= $${values.length}`);
    }
    values.push(query.limit ?? 100);

    const result = await this.databaseService.query(
      `
        SELECT
          e.entry_id, e.entry_number, e.entry_date::text, e.memo, e.source_type,
          l.debit::text, l.credit::text, l.description
        FROM journal_lines l
        JOIN journal_entries e ON e.entry_id = l.entry_id
        WHERE ${filters.join(" AND ")}
        ORDER BY e.entry_date DESC, e.created_at DESC, l.position
        LIMIT $${values.length}
      `,
      values
    );
    return { account: account.rows[0], lines: result.rows };
  }
}
