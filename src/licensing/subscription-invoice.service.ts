import { Injectable, Logger } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { emailAppUrl } from "../email/app-url";
import { EmailService } from "../email/email.service";
import { composeSubscriptionInvoiceEmail } from "../email/email-templates";
import { renderInvoicePdf } from "../email/invoice-pdf";
import {
  computeCustomMonthlyUsd,
  describeCustomPlan,
  termsFromRow,
  type CustomPlanRow
} from "./custom-plan";
import { DiscountService } from "./discount.service";

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
  /** Discount code to apply to this invoice's amount (admin assignment). */
  discountCode?: string;
}

interface SubRow extends Partial<CustomPlanRow> {
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
  /** Live printer count — what an "actual usage" custom basis bills on. */
  printer_count?: number | null;
}

@Injectable()
export class SubscriptionInvoiceService {
  private readonly logger = new Logger(SubscriptionInvoiceService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly email: EmailService,
    private readonly discounts: DiscountService
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

    // Amount: explicit override → grant is complimentary → NEGOTIATED custom
    // price → plan list price. The custom price is computed by the same helper
    // the resolver and the admin preview use, so the invoice always matches
    // the deal the admin saw when they set it up.
    const listPrice = sub.price_monthly_usd != null ? Number(sub.price_monthly_usd) : null;
    const customTerms = termsFromRow(sub);
    const customPrice = computeCustomMonthlyUsd(customTerms, Number(sub.printer_count ?? 0));
    let amountUsd: number;
    let note: string | null = null;
    if (input.amountUsd != null) {
      amountUsd = input.amountUsd;
    } else if (input.source === "grant_code") {
      amountUsd = 0;
      note = "Complimentary access — no charge (grant code).";
    } else if (customPrice != null) {
      amountUsd = customPrice;
      const summary = describeCustomPlan(customTerms, Number(sub.printer_count ?? 0));
      note = summary ? `Agreed plan — ${summary}.` : "Agreed plan pricing.";
    } else if (listPrice != null && Number.isFinite(listPrice)) {
      amountUsd = listPrice;
    } else {
      // Enterprise / contact-only plan with no list price: billed off-platform.
      amountUsd = 0;
      note = "Billed per agreement — this invoice records the plan, not a charge.";
    }
    amountUsd = Math.max(0, Math.round(amountUsd * 100) / 100);

    // Apply a discount code, if the admin supplied one. A code that doesn't
    // apply is reported in the note — never a reason to skip the invoice.
    let discountCode: string | null = null;
    let discountAmount: number | null = null;
    if (input.discountCode && amountUsd > 0) {
      const { discount, reason } = await this.discounts.resolve(
        input.discountCode,
        sub.plan_code,
        amountUsd,
        input.companyId
      );
      if (discount) {
        discountCode = discount.code;
        discountAmount = discount.amountOff;
        amountUsd = discount.finalAmount;
        const off =
          discount.kind === "percent" ? `${discount.value}% off` : `USD ${discount.amountOff.toFixed(2)} off`;
        note = `Discount ${discount.code} applied — ${off}.`;
        await this.discounts.recordRedemption(discount.discountId, input.companyId, discount.amountOff);
      } else if (reason) {
        this.logger.warn(`invoice for ${input.companyId}: discount not applied — ${reason}`);
        note = note ? `${note} ${reason}` : reason;
      }
    }

    const invoiceNumber = await this.mintInvoiceNumber();
    const periodStart = sub.created_at ? new Date(sub.created_at).toISOString() : new Date().toISOString();
    const recipient = (sub.owner_email ?? "").trim() || null;

    // Compose + attempt delivery FIRST so the persisted email_status reflects
    // reality. A missing recipient is a recorded 'skipped', not a failure.
    let emailStatus: "sent" | "dry_run" | "skipped" | "failed" = "skipped";
    let emailError: string | null = recipient ? null : "company has no owner email on file";

    if (recipient) {
      const invoiceData = {
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
      };
      const message = composeSubscriptionInvoiceEmail(invoiceData);

      // Attach the invoice as a real PDF document. Best-effort: if rendering
      // fails we still send the email (the HTML invoice is the same content),
      // because a missing attachment is far better than a missing invoice.
      let attachments: { filename: string; content: Buffer; contentType: string }[] | undefined;
      try {
        const pdf = await renderInvoicePdf(invoiceData);
        attachments = [
          { filename: `${invoiceNumber}.pdf`, content: pdf, contentType: "application/pdf" }
        ];
      } catch (e) {
        this.logger.warn(
          `invoice ${invoiceNumber}: PDF render failed, sending without attachment: ${e instanceof Error ? e.message : String(e)}`
        );
      }

      try {
        emailStatus = await this.email.send({
          to: recipient,
          subject: message.subject,
          text: message.text,
          html: message.html,
          ...(attachments ? { attachments } : {})
        });
      } catch (e) {
        emailStatus = "failed";
        emailError = e instanceof Error ? e.message : String(e);
        this.logger.warn(`invoice ${invoiceNumber}: delivery failed (invoice still recorded): ${emailError}`);
      }
    }

    // Persist the invoice regardless of email outcome — it's the billing
    // record. The discount columns arrive with the 2026-07-21 migration, so a
    // pre-migration DB falls back to the original column set.
    const baseValues = [
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
    ];
    try {
      await this.db.query(
        `INSERT INTO subscription_invoices
           (company_id, invoice_number, plan_code, plan_name, amount_usd, currency,
            source, period_start, period_end, recipient_email, email_status, email_error,
            note, issued_by, discount_code, discount_amount)
         VALUES ($1,$2,$3,$4,$5,'USD',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [...baseValues, discountCode, discountAmount]
      );
    } catch (e) {
      if ((e as { code?: string }).code !== "42703") throw e;
      await this.db.query(
        `INSERT INTO subscription_invoices
           (company_id, invoice_number, plan_code, plan_name, amount_usd, currency,
            source, period_start, period_end, recipient_email, email_status, email_error, note, issued_by)
         VALUES ($1,$2,$3,$4,$5,'USD',$6,$7,$8,$9,$10,$11,$12,$13)`,
        baseValues
      );
    }

    return invoiceNumber;
  }

  /** Company + its subscription + the plan's list price, in one read. */
  private async loadSubscription(companyId: string): Promise<SubRow | null> {
    const base = `cs.plan_code, cs.status, cs.current_period_end, cs.created_at,
              p.display_name AS plan_name, p.max_printers, p.price_monthly_usd,
              c.name AS company_name, c.owner_email, c.city, c.country_code,
              (SELECT count(*)::int FROM printer_instances pi
                WHERE pi.company_id = cs.company_id) AS printer_count`;
    const from = `FROM company_subscriptions cs
         JOIN plans p ON p.plan_code = cs.plan_code
         JOIN companies c ON c.company_id = cs.company_id
        WHERE cs.company_id = $1`;
    try {
      const { rows } = await this.db.query<SubRow>(
        `SELECT ${base},
                cs.custom_max_printers, cs.custom_price_model, cs.custom_price_amount,
                cs.custom_bundle_size, cs.custom_billing_basis, cs.custom_label,
                cs.custom_base_amount, cs.custom_included_printers, cs.custom_overage_model,
                cs.custom_min_monthly
         ${from}`,
        [companyId]
      );
      return rows[0] ?? null;
    } catch (err) {
      // custom_* columns not migrated yet — invoice at the plan's list price.
      if ((err as { code?: string }).code !== "42703") throw err;
      const { rows } = await this.db.query<SubRow>(`SELECT ${base} ${from}`, [companyId]);
      return rows[0] ?? null;
    }
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

  /** App origin for the "view billing" link — the one canonical public app
   *  address (see email/app-url.ts; never a CORS/preview origin). */
  private appUrl(): string {
    return emailAppUrl();
  }
}
