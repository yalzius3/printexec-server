import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
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
    private readonly discounts: DiscountService,
    private readonly config: ConfigService
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

    // ── The tenant is NOT emailed here ──────────────────────────────────
    // PrintExec is a product of ProArt Consulting, and ProArt is the legal
    // entity that invoices customers under its own tax-authority serial
    // numbers. Anything this platform generates is therefore a DRAFT, not a
    // tax document, and must never reach a tenant on its own.
    //
    // So: record the draft, and email it to the OPERATOR
    // (INVOICE_DRAFT_EMAIL). They pass it to ProArt, attach the finalized
    // file that comes back, and send it to the tenant from the admin console
    // (sendToTenant below). recipient_email is stored now so that later send
    // already knows where it is going.
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

    let draftStatus: "sent" | "dry_run" | "skipped" | "failed" = "skipped";
    let draftError: string | null = null;
    const draftTo = this.draftEmail();
    if (!draftTo) {
      draftError = "INVOICE_DRAFT_EMAIL is not set — draft recorded but not emailed.";
      this.logger.warn(`invoice ${invoiceNumber}: ${draftError}`);
    } else {
      // The draft PDF is the same working document the operator hands to
      // ProArt. Best-effort render: a missing attachment must not lose the
      // notification that a draft is waiting.
      let attachments: { filename: string; content: Buffer; contentType: string }[] | undefined;
      try {
        const pdf = await renderInvoicePdf(invoiceData);
        attachments = [
          { filename: `DRAFT-${invoiceNumber}.pdf`, content: pdf, contentType: "application/pdf" }
        ];
      } catch (e) {
        this.logger.warn(
          `invoice ${invoiceNumber}: draft PDF render failed, emailing without attachment: ${e instanceof Error ? e.message : String(e)}`
        );
      }

      const money = `USD ${amountUsd.toFixed(2)}`;
      const periodText = periodEnd
        ? `${new Date(periodStart).toISOString().slice(0, 10)} → ${new Date(periodEnd).toISOString().slice(0, 10)}`
        : `${new Date(periodStart).toISOString().slice(0, 10)} → ongoing`;
      // Deliberately internal copy — this is an operations notice, not the
      // customer-facing invoice email (which only goes out after ProArt).
      const lines = [
        `DRAFT invoice ${invoiceNumber} — not a tax document, not sent to the customer.`,
        "",
        `Company:  ${sub.company_name}`,
        `Owner:    ${recipient ?? "— no owner email on file —"}`,
        `Plan:     ${sub.plan_name ?? sub.plan_code}`,
        `Amount:   ${money}`,
        `Period:   ${periodText}`,
        `Source:   ${input.source}`,
        note ? `Note:     ${note}` : "",
        "",
        "Next: pass this to ProArt for its official serial number, then attach",
        "the finalized file to this draft in the admin console and send it.",
        "",
        `Admin console: ${this.appUrl()}`
      ].filter(Boolean);

      try {
        draftStatus = await this.email.send({
          to: draftTo,
          subject: `[DRAFT] Invoice ${invoiceNumber} — ${sub.company_name} — ${money}`,
          text: lines.join("\n"),
          ...(attachments ? { attachments } : {})
        });
      } catch (e) {
        draftStatus = "failed";
        draftError = e instanceof Error ? e.message : String(e);
        this.logger.warn(`invoice ${invoiceNumber}: draft email failed (draft still recorded): ${draftError}`);
      }
    }

    // The tenant-facing email fields stay empty until the finalized invoice is
    // actually sent from the admin console.
    const emailStatus: "sent" | "dry_run" | "skipped" | "failed" | null = null;
    const emailError: string | null = null;

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
      // Preferred shape: an explicit 'draft' plus the outcome of the operator
      // notification (2026-07-23 migration).
      await this.db.query(
        `INSERT INTO subscription_invoices
           (company_id, invoice_number, plan_code, plan_name, amount_usd, currency,
            source, period_start, period_end, recipient_email, email_status, email_error,
            note, issued_by, discount_code, discount_amount,
            status, draft_email_status, draft_email_error)
         VALUES ($1,$2,$3,$4,$5,'USD',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'draft',$16,$17)`,
        [...baseValues, discountCode, discountAmount, draftStatus, draftError]
      );
    } catch (e) {
      if ((e as { code?: string }).code !== "42703") throw e;
      this.logger.warn(
        `invoice ${invoiceNumber}: draft columns missing — apply migrations/2026-07-23_invoice_drafts_custom_tiers.sql. Recorded without draft state (the customer was still NOT emailed).`
      );
      try {
        await this.db.query(
          `INSERT INTO subscription_invoices
             (company_id, invoice_number, plan_code, plan_name, amount_usd, currency,
              source, period_start, period_end, recipient_email, email_status, email_error,
              note, issued_by, discount_code, discount_amount)
           VALUES ($1,$2,$3,$4,$5,'USD',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [...baseValues, discountCode, discountAmount]
        );
      } catch (e2) {
        if ((e2 as { code?: string }).code !== "42703") throw e2;
        await this.db.query(
          `INSERT INTO subscription_invoices
             (company_id, invoice_number, plan_code, plan_name, amount_usd, currency,
              source, period_start, period_end, recipient_email, email_status, email_error, note, issued_by)
           VALUES ($1,$2,$3,$4,$5,'USD',$6,$7,$8,$9,$10,$11,$12,$13)`,
          baseValues
        );
      }
    }

    return invoiceNumber;
  }

  /** Where auto-generated drafts are sent for the ProArt hand-off. */
  private draftEmail(): string | null {
    const raw = (this.config.get<string>("INVOICE_DRAFT_EMAIL") ?? "").trim();
    return raw || null;
  }

  /** Public wrapper so the admin console can mint a number for a hand-added
   *  invoice using the same atomic per-year counter. */
  mintNumber(): Promise<string> {
    return this.mintInvoiceNumber();
  }

  /** Re-render a stored draft as a PDF, for handing to ProArt. */
  async renderDraftPdf(invoiceId: string): Promise<Buffer> {
    const { rows } = await this.db.query<{
      invoice_number: string;
      plan_name: string | null;
      plan_code: string | null;
      amount_usd: string;
      currency: string;
      source: string;
      period_start: string | Date | null;
      period_end: string | Date | null;
      note: string | null;
      created_at: string | Date;
      recipient_email: string | null;
      company_name: string;
      city: string | null;
      country_code: string | null;
      max_printers: number | null;
    }>(
      `SELECT i.invoice_number, i.plan_name, i.plan_code, i.amount_usd, i.currency, i.source,
              i.period_start, i.period_end, i.note, i.created_at, i.recipient_email,
              c.name AS company_name, c.city, c.country_code, p.max_printers
         FROM subscription_invoices i
         JOIN companies c ON c.company_id = i.company_id
         LEFT JOIN plans p ON p.plan_code = i.plan_code
        WHERE i.invoice_id = $1`,
      [invoiceId]
    );
    const inv = rows[0];
    if (!inv) throw new Error("Invoice not found.");
    return renderInvoicePdf({
      invoiceNumber: inv.invoice_number,
      issuedAt: new Date(inv.created_at).toISOString(),
      company: {
        name: inv.company_name,
        ownerEmail: inv.recipient_email,
        city: inv.city,
        countryCode: inv.country_code
      },
      plan: { name: inv.plan_name ?? inv.plan_code ?? "—", maxPrinters: inv.max_printers },
      amountUsd: Number(inv.amount_usd),
      currency: inv.currency ?? "USD",
      source: inv.source,
      periodStart: inv.period_start ? new Date(inv.period_start).toISOString() : new Date(inv.created_at).toISOString(),
      periodEnd: inv.period_end ? new Date(inv.period_end).toISOString() : null,
      status: "draft",
      note: inv.note,
      appUrl: this.appUrl()
    });
  }

  /** Park ProArt's finalized file in the uploads bucket, under a key that
   *  can't collide across invoices. Returns the object key. */
  async storeOfficialFile(invoiceId: string, buffer: Buffer, filename: string): Promise<string> {
    const safe = (filename || "invoice.pdf").replace(/[^\w.\-]+/g, "_").slice(-80);
    const key = `subscription-invoices/${invoiceId}/${Date.now()}-${safe}`;
    const { error } = await this.storage()
      .storage.from(this.bucket())
      .upload(key, buffer, { contentType: "application/pdf", upsert: true });
    if (error) throw new Error(`Could not store the finalized invoice: ${error.message}`);
    return key;
  }

  /** Read back the finalized file so it can be attached to the tenant email. */
  async loadOfficialFile(key: string): Promise<Buffer> {
    const { data, error } = await this.storage().storage.from(this.bucket()).download(key);
    if (error || !data) {
      throw new Error(`Could not read the finalized invoice: ${error?.message ?? "missing file"}`);
    }
    return Buffer.from(await data.arrayBuffer());
  }

  private bucket(): string {
    return this.config.get<string>("SUPABASE_UPLOAD_BUCKET") ?? "uploads";
  }

  private storage(): SupabaseClient {
    if (!this.supabase) {
      this.supabase = createClient(
        this.config.getOrThrow<string>("SUPABASE_URL"),
        this.config.getOrThrow<string>("SUPABASE_SERVICE_ROLE_KEY"),
        { auth: { persistSession: false } }
      );
    }
    return this.supabase;
  }
  private supabase: SupabaseClient | null = null;

  /**
   * Email ProArt's finalized invoice to the tenant. This is the ONLY path that
   * puts an invoice in a customer's inbox, and it deliberately sends the exact
   * file the operator attached — never a re-render — so what the customer
   * holds is the real, tax-numbered document ProArt issued.
   */
  async sendToTenant(
    invoiceId: string,
    file: { buffer: Buffer; filename: string },
    sentBy: string
  ): Promise<{ status: "sent" | "dry_run"; to: string }> {
    const { rows } = await this.db.query<{
      invoice_number: string;
      official_number: string | null;
      recipient_email: string | null;
      amount_usd: string;
      plan_name: string | null;
      company_name: string;
      status: string;
    }>(
      `SELECT i.invoice_number, i.official_number, i.recipient_email, i.amount_usd,
              i.plan_name, i.status, c.name AS company_name
         FROM subscription_invoices i
         JOIN companies c ON c.company_id = i.company_id
        WHERE i.invoice_id = $1`,
      [invoiceId]
    );
    const inv = rows[0];
    if (!inv) throw new Error("Invoice not found.");
    const to = (inv.recipient_email ?? "").trim();
    if (!to) throw new Error("This company has no owner email on file to send to.");

    const ref = inv.official_number?.trim() || inv.invoice_number;
    const text = [
      `Hello,`,
      "",
      `Please find attached your invoice ${ref}${inv.plan_name ? ` for the ${inv.plan_name} plan` : ""}.`,
      "",
      `Amount: USD ${Number(inv.amount_usd).toFixed(2)}`,
      "",
      "Thank you for using PrintExec.",
      "",
      "PrintExec — a product of ProArt Consulting"
    ].join("\n");

    const status = await this.email.send({
      to,
      subject: `Invoice ${ref}${inv.plan_name ? ` — ${inv.plan_name} plan` : ""}`,
      text,
      attachments: [
        { filename: file.filename, content: file.buffer, contentType: "application/pdf" }
      ]
    });

    await this.db.query(
      `UPDATE subscription_invoices
          SET status = 'sent', sent_at = now(), sent_to = $2,
              email_status = $3, email_error = NULL, issued_by = COALESCE(issued_by, $4)
        WHERE invoice_id = $1`,
      [invoiceId, to, status, sentBy]
    );
    return { status, to };
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
