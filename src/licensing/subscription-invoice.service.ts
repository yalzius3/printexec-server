import { Injectable, Logger } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { EmailService } from "../email/email.service";
import { composeSubscriptionInvoiceEmail } from "../email/email-templates";

// ════════════════════════════════════════════════════════════════
// SUBSCRIPTION INVOICES
//
// Issues a PrintExec invoice — and emails it to the workspace owner — whenever
// a company's subscription is activated onto a real plan:
//   · a grant code is redeemed          (source 'grant_code', complimentary)
//   · an admin assigns a plan           (source 'manual', plan list price)
//   · (later) a payment settles         (source 'stripe'/'payoneer', paid amount)
//
// Design mirrors the other outbound-email paths:
//   · the invoice number is minted atomically per year (PX-INV-YYYY-NNNNN),
//     the same row-lock upsert as order numbers;
//   · delivery rides EMAIL_ENABLED (dry-run compose otherwise);
//   · every attempt is persisted in subscription_invoices with its email
//     outcome (sent | dry_run | skipped | failed) — the durable billing record;
//   · a dedupe guard skips re-issuing for the same (company, plan, period,
//     source) so re-redeeming a code or re-saving the same assignment doesn't
//     double-invoice.
//
// CRITICAL: issuing is best-effort and MUST NEVER fail the subscription
// mutation that triggered it. Every public method swallows its own errors
// (including the table not being migrated yet, Postgres 42P01) and logs.
// ════════════════════════════════════════════════════════════════

export type InvoiceSource = "grant_code" | "manual" | "stripe" | "payoneer";

export interface IssueInvoiceInput {
  companyId: string;
  source: InvoiceSource;
  /** Override the amount (e.g. the settled payment). Defaults to the plan's
   *  list price for 'manual', 0 for 'grant_code'. */
  amountUsd?: number;
  /** Platform-admin email when an admin triggered it; defaults to 'system'. */
  issuedBy?: string;
}

interface SubRow {
  plan_code: string;
  plan_name: string | null;
  max_printers: number | null;
  price_monthly_usd: string | null;
  status: string;
  current_period_end: string | Date | null;
  created_at: string | Date | null;
  company_name: string;
  owner_email: string | null;
  city: string | null;
  country_code: string | null;
}

@Injectable()
export class SubscriptionInvoiceService {
  private readonly logger = new Logger(SubscriptionInvoiceService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly email: EmailService
  ) {}

  /**
   * Issue + email an invoice for a company's current subscription. Safe to call
   * inline right after a subscription mutation: it never throws. Returns the
   * invoice number when one was issued, or null when skipped (deduped, no plan,
   * trial, pre-migration, or any error).
   */
  async issueForSubscription(input: IssueInvoiceInput): Promise<string | null> {
    try {
      return await this.issue(input);
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === "42P01") {
        this.logger.warn(
          "subscription invoice skipped: subscription_invoices missing — apply migrations/2026-07-20_subscription_invoices.sql."
        );
      } else {
        this.logger.warn(
          `subscription invoice failed for company ${input.companyId} (non-fatal): ${e instanceof Error ? e.message : String(e)}`
        );
      }
      return null;
    }
  }

  private async issue(input: IssueInvoiceInput): Promise<string | null> {
    const sub = await this.loadSubscription(input.companyId);
    if (!sub) return null;
    // Trials are not subscriptions — never invoice them.
    if (sub.plan_code === "trial" || sub.status === "trialing") return null;

    const periodEnd = sub.current_period_end ? new Date(sub.current_period_end).toISOString() : null;

    // Dedupe: one invoice per (company, source, plan, period). Re-redeeming a
    // code or re-saving the same assignment is a no-op.
    const existing = await this.db.query<{ invoice_number: string }>(
      `SELECT invoice_number FROM subscription_invoices
        WHERE company_id = $1 AND source = $2 AND plan_code = $3
          AND coalesce(period_end, 'infinity') = coalesce($4::timestamptz, 'infinity')
          AND status = 'issued'
        LIMIT 1`,
      [input.companyId, input.source, sub.plan_code, periodEnd]
    );
    if (existing.rowCount) return existing.rows[0]!.invoice_number;

    // Amount: explicit override → grant is complimentary → plan list price.
    const listPrice = sub.price_monthly_usd != null ? Number(sub.price_monthly_usd) : null;
    let amountUsd: number;
    let note: string | null = null;
    if (input.amountUsd != null) {
      amountUsd = input.amountUsd;
    } else if (input.source === "grant_code") {
      amountUsd = 0;
      note = "Complimentary access — no charge (grant code).";
    } else if (listPrice != null && Number.isFinite(listPrice)) {
      amountUsd = listPrice;
    } else {
      // Enterprise / contact-only plan with no list price: billed off-platform.
      amountUsd = 0;
      note = "Billed per agreement — this invoice records the plan, not a charge.";
    }
    amountUsd = Math.max(0, Math.round(amountUsd * 100) / 100);

    const invoiceNumber = await this.mintInvoiceNumber();
    const periodStart = sub.created_at ? new Date(sub.created_at).toISOString() : new Date().toISOString();
    const recipient = (sub.owner_email ?? "").trim() || null;

    // Compose + attempt delivery FIRST so the persisted email_status reflects
    // reality. A missing recipient is a recorded 'skipped', not a failure.
    let emailStatus: "sent" | "dry_run" | "skipped" | "failed" = "skipped";
    let emailError: string | null = recipient ? null : "company has no owner email on file";

    if (recipient) {
      const message = composeSubscriptionInvoiceEmail({
        invoiceNumber,
        issuedAt: new Date().toISOString(),
        company: {
          name: sub.company_name,
          ownerEmail: recipient,
          city: sub.city,
          countryCode: sub.country_code
        },
        plan: { name: sub.plan_name ?? sub.plan_code, maxPrinters: sub.max_printers },
        amountUsd,
        currency: "USD",
        source: input.source,
        periodStart,
        periodEnd,
        status: sub.status,
        note,
        appUrl: this.appUrl()
      });
      try {
        emailStatus = await this.email.send({
          to: recipient,
          subject: message.subject,
          text: message.text,
          html: message.html
        });
      } catch (e) {
        emailStatus = "failed";
        emailError = e instanceof Error ? e.message : String(e);
        this.logger.warn(`invoice ${invoiceNumber}: delivery failed (invoice still recorded): ${emailError}`);
      }
    }

    // Persist the invoice regardless of email outcome — it's the billing record.
    await this.db.query(
      `INSERT INTO subscription_invoices
         (company_id, invoice_number, plan_code, plan_name, amount_usd, currency,
          source, period_start, period_end, recipient_email, email_status, email_error, note, issued_by)
       VALUES ($1,$2,$3,$4,$5,'USD',$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        input.companyId,
        invoiceNumber,
        sub.plan_code,
        sub.plan_name ?? sub.plan_code,
        amountUsd,
        input.source,
        periodStart,
        periodEnd,
        recipient,
        emailStatus,
        emailError,
        note,
        input.issuedBy ?? "system"
      ]
    );

    return invoiceNumber;
  }

  /** Company + its subscription + the plan's list price, in one read. */
  private async loadSubscription(companyId: string): Promise<SubRow | null> {
    const { rows } = await this.db.query<SubRow>(
      `SELECT cs.plan_code, cs.status, cs.current_period_end, cs.created_at,
              p.display_name AS plan_name, p.max_printers, p.price_monthly_usd,
              c.name AS company_name, c.owner_email, c.city, c.country_code
         FROM company_subscriptions cs
         JOIN plans p ON p.plan_code = cs.plan_code
         JOIN companies c ON c.company_id = cs.company_id
        WHERE cs.company_id = $1`,
      [companyId]
    );
    return rows[0] ?? null;
  }

  /**
   * Atomic per-year invoice number PX-INV-YYYY-NNNNN. The upsert row-locks the
   * (year) counter so concurrent activations serialise and never collide —
   * identical guarantee to order numbering.
   */
  private async mintInvoiceNumber(): Promise<string> {
    const year = new Date().getUTCFullYear();
    const { rows } = await this.db.query<{ last_value: string }>(
      `INSERT INTO subscription_invoice_sequences (year, last_value)
       VALUES ($1, 1)
       ON CONFLICT (year)
       DO UPDATE SET last_value = subscription_invoice_sequences.last_value + 1
       RETURNING last_value`,
      [year]
    );
    const seq = Number(rows[0]?.last_value);
    if (!Number.isInteger(seq) || seq < 1) {
      throw new Error("invoice-number sequence bump returned no usable value");
    }
    return `PX-INV-${year}-${String(seq).padStart(5, "0")}`;
  }

  /** App origin for the "view billing" link (same resolution as the notices). */
  private appUrl(): string {
    return (process.env.PUBLIC_APP_URL || process.env.ALLOWED_ORIGIN || "https://solution.printexec.xyz")
      .split(",")[0]!
      .trim()
      .replace(/\/+$/, "");
  }
}
