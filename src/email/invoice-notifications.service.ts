import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { emailAppUrl } from "./app-url";
import { EmailService } from "./email.service";
import { renderCustomerInvoicePdf } from "./customer-invoice-pdf";
import {
  composeCustomerInvoiceEmail,
  type CustomerInvoiceEmailData,
  type CustomerInvoiceLine
} from "./email-templates";

// ════════════════════════════════════════════════════════════════
// CUSTOMER INVOICE EMAIL — the shop bills its customer
//
// One rule drives everything here: THE CUSTOMER IS EMAILED WHEN THE INVOICE IS
// ISSUED. That covers both routes the shop actually uses —
//   · confirm the order, issue the invoice straight away → the mail goes now;
//   · confirm the order, leave the draft for the accountant to edit → nothing
//     is sent until they issue it, and then it goes.
// Issuing is also the only event that means the bill is real: createInvoiceFrom
// Order re-syncs a DRAFT to the order's current pricing on every open, so a
// draft's numbers are still moving. An issued invoice is posted to the ledger
// and immutable (void + reissue is the only way back), which is exactly the
// document a customer should receive.
//
// BOTH A NUDGE AND A SWEEP:
//   · FinanceService.issueInvoice calls sendForInvoice() right after its
//     transaction commits, so the customer gets the invoice in seconds.
//   · An OnModuleInit timer sweeps for issued invoices with no settled row,
//     so a transport blip, a crash between commit and send, or an invoice
//     issued by some future code path still gets delivered.
// The invoice_emails ledger makes the two safe together: whoever gets there
// first writes the settled row and the other finds nothing to do.
//
// AFTER COMMIT, NEVER INSIDE: sending holds no DB transaction open, and a
// bounced email must never roll back a posted journal entry. sendForInvoice()
// therefore never throws — the worst case is a logged failure that the next
// sweep retries.
//
// Tunables (env):
//   EMAIL_ENABLED            "true" to attempt real delivery; else dry-run
//   EMAIL_SWEEP_INTERVAL_MS  sweep cadence (default 2 min) — shared with the
//                            order-notification sweep
// ════════════════════════════════════════════════════════════════

/** Issued = posted to the ledger. 'draft' never mails; 'void' never mails. */
const ISSUED_STATUSES = ["open", "partial", "paid"] as const;

/**
 * Two idempotency slots per invoice. The automatic send owns 'invoice_issued'
 * and is exactly-once; an operator resend owns 'invoice_resend' so it neither
 * consumes nor is blocked by the automatic slot (and can be repeated — the
 * service clears the prior resend row first).
 */
type EmailType = "invoice_issued" | "invoice_resend";

type InvoiceRow = {
  invoice_id: string;
  company_id: string;
  customer_id: string | null;
  invoice_number: string;
  status: string;
  issue_date: string | Date | null;
  due_date: string | Date | null;
  currency: string | null;
  subtotal: string | null;
  tax_total: string | null;
  total: string | null;
  amount_paid: string | null;
  balance_due: string | null;
  memo: string | null;
  terms: string | null;
  counterparty_name: string | null;
  order_id: string | null;
  order_number: string | null;
  order_title: string | null;
  guest_email: string | null;
  company_name: string;
  company_phone: string | null;
  company_website: string | null;
  company_city: string | null;
  company_country: string | null;
  company_currency: string | null;
  customer_type: "b2b" | "b2c" | null;
  first_name: string | null;
  last_name: string | null;
  business_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  customer_deleted_at: string | Date | null;
  // The company's master switch for automatic customer messages. Gates the
  // 'invoice_issued' slot only — an operator resend is a human pressing send,
  // which this switch has nothing to say about. Read migration-safely in
  // loadInvoice, so it's true on a DB without the column.
  automated_messages_enabled: boolean;
};

type LineRow = {
  description: string;
  quantity: string;
  unit_price: string;
  amount: string;
};

export type InvoiceEmailOutcome = "sent" | "dry_run" | "skipped" | "failed";

const num = (v: string | number | null | undefined): number => {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

@Injectable()
export class InvoiceNotificationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("InvoiceNotificationsService");
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly sweepIntervalMs: number;

  constructor(
    private readonly db: DatabaseService,
    private readonly email: EmailService
  ) {
    const raw = Number(process.env.EMAIL_SWEEP_INTERVAL_MS);
    this.sweepIntervalMs = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2 * 60 * 1000;
  }

  onModuleInit(): void {
    // Boot breadcrumb — the order-email sweep learned the hard way that a
    // silent sweep makes "is this even deployed?" unanswerable from the logs.
    this.logger.log(
      `invoice-email sweep armed (live=${this.email.isLiveDelivery}, interval=${this.sweepIntervalMs}ms)`
    );
    setTimeout(() => void this.tick(), 30_000);
    this.timer = setInterval(() => void this.tick(), this.sweepIntervalMs);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Send one invoice to its customer. Safe to call inline right after the
   * issuing transaction commits: it NEVER throws and never opens a transaction
   * of its own. Returns the outcome for the caller to surface (the resend
   * endpoint does; the issue hook ignores it and lets the sweep retry).
   */
  async sendForInvoice(
    companyId: string,
    invoiceId: string,
    emailType: EmailType = "invoice_issued"
  ): Promise<InvoiceEmailOutcome> {
    try {
      const row = await this.loadInvoice(companyId, invoiceId);
      if (!row) return "skipped";
      return await this.deliver(row, emailType);
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === "42P01") {
        this.logger.warn(
          "invoice email skipped: invoice_emails missing — apply migrations/2026-07-22_invoice_customer_emails.sql."
        );
      } else {
        this.logger.warn(
          `invoice email failed for invoice ${invoiceId} (non-fatal): ${(e as Error).message}`
        );
      }
      return "failed";
    }
  }

  /**
   * Clear the resend slot and send again. Used by the operator-facing "Resend"
   * action, which is also the ONLY way to deliberately mail an invoice the
   * launch backfill suppressed.
   */
  async resendForInvoice(companyId: string, invoiceId: string): Promise<InvoiceEmailOutcome> {
    try {
      await this.db.query(
        `DELETE FROM invoice_emails
          WHERE company_id = $1 AND invoice_id = $2 AND email_type = 'invoice_resend'`,
        [companyId, invoiceId]
      );
    } catch (e) {
      if ((e as { code?: string })?.code !== "42P01") throw e;
      // Table not migrated yet — sendForInvoice reports it properly below.
    }
    return this.sendForInvoice(companyId, invoiceId, "invoice_resend");
  }

  /** What the client shows next to the invoice: was the customer emailed? */
  async getEmailState(
    companyId: string,
    invoiceId: string
  ): Promise<{
    status: string | null;
    email_type: string | null;
    recipient_email: string | null;
    error: string | null;
    created_at: string | null;
  }> {
    try {
      const res = await this.db.query<{
        status: string;
        email_type: string;
        recipient_email: string | null;
        error: string | null;
        created_at: string;
      }>(
        // ::text — pg hands TIMESTAMPTZ back as a JS Date, and callers here
        // treat this as a string.
        `SELECT status, email_type, recipient_email, error, created_at::text
           FROM invoice_emails
          WHERE company_id = $1 AND invoice_id = $2
          ORDER BY created_at DESC
          LIMIT 1`,
        [companyId, invoiceId]
      );
      const row = res.rows[0];
      return {
        status: row?.status ?? null,
        email_type: row?.email_type ?? null,
        recipient_email: row?.recipient_email ?? null,
        error: row?.error ?? null,
        created_at: row?.created_at ?? null
      };
    } catch (e) {
      // Pre-migration: report "nothing sent yet" rather than 500 the window.
      if ((e as { code?: string })?.code !== "42P01") throw e;
      return { status: null, email_type: null, recipient_email: null, error: null, created_at: null };
    }
  }

  // ── Sweep ─────────────────────────────────────────────────────────────────

  /** One sweep. Re-entrancy-guarded so a slow tick can't overlap itself. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const pending = await this.findEligibleInvoices();
      if (pending.length === 0) return;

      let sent = 0;
      let skipped = 0;
      let failed = 0;
      for (const { company_id, invoice_id } of pending) {
        const outcome = await this.sendForInvoice(company_id, invoice_id, "invoice_issued");
        if (outcome === "sent" || outcome === "dry_run") sent += 1;
        else if (outcome === "skipped") skipped += 1;
        else failed += 1;
      }

      const verb = this.email.isLiveDelivery ? "sent" : "dry-run composed";
      this.logger.log(
        `invoice-emails: ${verb} ${sent} invoice(s), skipped ${skipped} (no recipient), ${failed} failed`
      );
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === "42P01") return; // table not migrated yet — stay quiet per tick
      this.logger.warn(`invoice-emails tick failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Issued invoices with no settled email row yet. The NOT EXISTS guard makes
   * the sweep self-limiting: once an invoice has a sent/dry_run/skipped row it
   * drops out for good, so neither the historical backlog (suppressed by the
   * migration's backfill) nor already-emailed invoices are re-scanned forever.
   */
  private async findEligibleInvoices(): Promise<{ company_id: string; invoice_id: string }[]> {
    const res = await this.db.query<{ company_id: string; invoice_id: string }>(
      `SELECT i.company_id, i.invoice_id
         FROM invoices i
        WHERE i.status = ANY($1::text[])
          AND NOT EXISTS (
            SELECT 1 FROM invoice_emails e
             WHERE e.company_id = i.company_id
               AND e.invoice_id = i.invoice_id
               AND e.email_type = 'invoice_issued'
               AND e.status IN ('sent', 'dry_run', 'skipped')
          )
        ORDER BY i.updated_at ASC
        LIMIT 50`,
      [[...ISSUED_STATUSES]]
    );
    return res.rows;
  }

  // ── Delivery ──────────────────────────────────────────────────────────────

  private async deliver(row: InvoiceRow, emailType: EmailType): Promise<InvoiceEmailOutcome> {
    // A draft's numbers are still being re-synced from the order — never mail
    // one, whatever asked us to. Void invoices are cancelled documents.
    if (!ISSUED_STATUSES.includes(row.status as (typeof ISSUED_STATUSES)[number])) {
      return "skipped";
    }

    // Automatic customer messages are switched off for this company. Only the
    // AUTOMATIC slot is gated: 'invoice_resend' is an operator pressing send by
    // hand, and a master switch on background senders has no business blocking a
    // deliberate action. Recorded as settled (not left pending) for the same
    // reason the order sweep does it — so switching back on doesn't mail out
    // every invoice issued in the meantime.
    if (emailType === "invoice_issued" && !row.automated_messages_enabled) {
      await this.record(row, emailType, {
        status: "skipped",
        error: "automated messages are switched off for this company"
      });
      return "skipped";
    }

    const recipient = this.resolveRecipient(row);
    if (!recipient) {
      await this.record(row, emailType, { status: "skipped", error: this.skipReason(row) });
      return "skipped";
    }

    const [lines, brand] = await Promise.all([
      this.loadLines(row.company_id, row.invoice_id),
      this.resolveBrand(row.company_id)
    ]);
    const data = this.toEmailData(row, lines, recipient, brand);
    const message = composeCustomerInvoiceEmail(data);

    // A PDF failure must not cost the customer their invoice — send the
    // (fully itemised) email body regardless and note the missing attachment.
    let pdf: Buffer | null = null;
    try {
      pdf = await renderCustomerInvoicePdf(data);
    } catch (e) {
      this.logger.warn(
        `invoice-emails: PDF render failed for ${row.invoice_number}, sending without attachment: ${(e as Error).message}`
      );
    }

    let result: "sent" | "dry_run";
    try {
      result = await this.email.send({
        to: recipient,
        subject: message.subject,
        text: message.text,
        html: message.html,
        ...(pdf
          ? {
              attachments: [
                {
                  filename: `${sanitiseFilename(row.invoice_number)}.pdf`,
                  content: pdf,
                  contentType: "application/pdf"
                }
              ]
            }
          : {})
      });
    } catch (e) {
      // Leave it un-recorded so it stays eligible and retries next sweep.
      this.logger.warn(
        `invoice-emails: delivery failed for ${row.invoice_number}: ${(e as Error).message}`
      );
      return "failed";
    }

    await this.record(row, emailType, {
      status: result,
      recipientEmail: recipient,
      subject: message.subject,
      body: message.text
    });
    await this.logHistory(row, recipient, result);
    return result;
  }

  /**
   * The email we can actually deliver to. Prefer the CRM customer's address;
   * fall back to the guest email captured on the order, so a walk-in order
   * still gets its bill. A soft-deleted customer is never mailed.
   */
  private resolveRecipient(row: InvoiceRow): string | null {
    if (row.customer_id && !row.customer_deleted_at) {
      const email = (row.customer_email ?? "").trim();
      if (email.length > 0) return email;
    }
    const guest = (row.guest_email ?? "").trim();
    return guest.length > 0 ? guest : null;
  }

  private skipReason(row: InvoiceRow): string {
    if (!row.customer_id) return "invoice has no customer attached and the order has no guest email";
    if (row.customer_deleted_at) return "customer has been deleted";
    return "customer has no email on file";
  }

  // ── Loading ───────────────────────────────────────────────────────────────

  /**
   * One read for the whole document: invoice + issuing company + billed
   * customer + the order it bills.
   *
   * NOTE the company's contact email is deliberately NULL and not selected:
   * companies.owner_email is a PERSONAL login address captured at signup, not a
   * customer-facing contact. Same policy as the order emails — customers get
   * the shop's phone and website until companies carry a public contact email.
   */
  private async loadInvoice(companyId: string, invoiceId: string): Promise<InvoiceRow | null> {
    const res = await this.db.query<InvoiceRow>(
      `SELECT
          i.invoice_id, i.company_id, i.customer_id, i.invoice_number, i.status,
          i.issue_date, i.due_date, i.currency,
          i.subtotal::text, i.tax_total::text, i.total::text,
          i.amount_paid::text, i.balance_due::text,
          i.memo, i.terms, i.counterparty_name, i.order_id,
          o.order_number, o.title AS order_title, o.guest_email,
          comp.name             AS company_name,
          comp.phone            AS company_phone,
          comp.website          AS company_website,
          comp.city             AS company_city,
          comp.country_code     AS company_country,
          comp.currency_default AS company_currency,
          -- Via to_jsonb so a deployment without the 2026-08-13 migration keeps
          -- mailing invoices instead of throwing on an unknown column. Absent
          -- key → NULL → COALESCE true = today's behaviour.
          COALESCE((to_jsonb(comp) ->> 'automated_messages_enabled')::boolean, true)
                                AS automated_messages_enabled,
          c.customer_type, c.first_name, c.last_name, c.business_name,
          c.email               AS customer_email,
          c.phone               AS customer_phone,
          c.deleted_at          AS customer_deleted_at
        FROM invoices i
        JOIN companies comp ON comp.company_id = i.company_id
        LEFT JOIN orders o ON o.order_id = i.order_id AND o.company_id = i.company_id
        LEFT JOIN customers c ON c.customer_id = i.customer_id
       WHERE i.company_id = $1 AND i.invoice_id = $2`,
      [companyId, invoiceId]
    );
    return res.rows[0] ?? null;
  }

  private async loadLines(companyId: string, invoiceId: string): Promise<LineRow[]> {
    const res = await this.db.query<LineRow>(
      `SELECT description, quantity::text, unit_price::text, amount::text
         FROM invoice_lines
        WHERE company_id = $1 AND invoice_id = $2
        ORDER BY position, description`,
      [companyId, invoiceId]
    );
    return res.rows;
  }

  /**
   * Logo URL + slogan for the email header.
   *
   * Guarded and kept OUT of loadInvoice's main query on purpose: those columns
   * ship ahead of their migration, and one missing column in the main query
   * would stop ALL invoice mail. Here, a failure just costs the branding.
   *
   * The URL is the unauthenticated /api/uploads/logo/:id route on the canonical
   * app origin — email clients carry no session — cache-busted on the stored
   * filename, since the path itself is stable and clients cache images hard.
   */
  private async resolveBrand(
    companyId: string
  ): Promise<{ logoUrl: string | null; slogan: string | null }> {
    try {
      const res = await this.db.query<{ logo_url: string | null; slogan: string | null }>(
        "SELECT logo_url, slogan FROM companies WHERE company_id = $1",
        [companyId]
      );
      const stored = res.rows[0]?.logo_url;
      const slogan = res.rows[0]?.slogan?.trim() || null;
      if (!stored) return { logoUrl: null, slogan };
      const filename = stored.split("/").pop() ?? "";
      const version = filename ? `?v=${encodeURIComponent(filename)}` : "";
      return { logoUrl: `${emailAppUrl()}/api/uploads/logo/${companyId}${version}`, slogan };
    } catch {
      // branding columns not migrated yet — send an unbranded (but correct) mail
      return { logoUrl: null, slogan: null };
    }
  }

  /** Map DB rows into the shape the template and the PDF both consume. */
  private toEmailData(
    row: InvoiceRow,
    lines: LineRow[],
    recipient: string,
    brand: { logoUrl: string | null; slogan: string | null }
  ): CustomerInvoiceEmailData {
    const crmName =
      row.customer_type === "b2b"
        ? row.business_name
        : [row.first_name, row.last_name].filter((p) => !!p && p.trim().length > 0).join(" ");
    // counterparty_name is the snapshot taken when the invoice was raised — it
    // survives the customer being renamed or deleted, so it wins as the
    // billed-to name; the live CRM name is only the fallback.
    const displayName = (row.counterparty_name ?? "").trim() || (crmName ?? "").trim() || "Customer";
    const contactName = [row.first_name, row.last_name]
      .filter((p): p is string => !!p && p.trim().length > 0)
      .join(" ")
      .trim();

    const invoiceLines: CustomerInvoiceLine[] = lines.map((l) => ({
      description: l.description,
      quantity: num(l.quantity),
      unitPrice: num(l.unit_price),
      amount: num(l.amount)
    }));

    return {
      company: {
        name: row.company_name,
        slogan: brand.slogan,
        phone: row.company_phone,
        email: null,
        website: row.company_website,
        city: row.company_city,
        countryCode: row.company_country,
        logoUrl: brand.logoUrl
      },
      customer: {
        displayName,
        contactName: contactName.length > 0 ? contactName : null,
        email: recipient,
        phone: row.customer_phone,
        isBusiness: row.customer_type === "b2b"
      },
      invoice: {
        number: row.invoice_number,
        issueDate: row.issue_date,
        dueDate: row.due_date,
        // The document's own currency wins; the company default is the fallback
        // (invoices.currency is nullable and usually left unset).
        currency: row.currency ?? row.company_currency,
        lines: invoiceLines,
        subtotal: num(row.subtotal),
        taxTotal: num(row.tax_total),
        total: num(row.total),
        amountPaid: num(row.amount_paid),
        balanceDue: num(row.balance_due),
        memo: row.memo,
        terms: row.terms,
        orderNumber: row.order_number,
        orderTitle: row.order_title
      }
    };
  }

  // ── Bookkeeping ───────────────────────────────────────────────────────────

  /**
   * Persist the outcome. ON CONFLICT DO NOTHING makes a double-send race (the
   * issue hook and a sweep landing together) a no-op. Best-effort, but noisy on
   * failure: an un-recorded 'sent' would re-send on the next tick.
   */
  private async record(
    row: InvoiceRow,
    emailType: EmailType,
    detail: {
      status: "sent" | "dry_run" | "skipped";
      recipientEmail?: string | null;
      subject?: string | null;
      body?: string | null;
      error?: string | null;
    }
  ): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO invoice_emails
           (company_id, invoice_id, customer_id, email_type, recipient_email,
            subject, body, status, error, invoice_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (company_id, invoice_id, email_type) DO NOTHING`,
        [
          row.company_id,
          row.invoice_id,
          row.customer_id,
          emailType,
          detail.recipientEmail ?? null,
          detail.subject ?? null,
          detail.body ?? null,
          detail.status,
          detail.error ?? null,
          row.status
        ]
      );
    } catch (e) {
      this.logger.warn(
        `invoice-emails: failed to record ${detail.status} for ${row.invoice_number}: ${(e as Error).message}`
      );
    }
  }

  /** Best-effort breadcrumb on the shared order_history feed. */
  private async logHistory(
    row: InvoiceRow,
    recipient: string,
    result: "sent" | "dry_run"
  ): Promise<void> {
    // Only invoices raised from an order have a feed to appear on.
    if (!row.order_id || !row.order_number) return;
    const verb = result === "sent" ? "Sent" : "Composed (dry-run)";
    try {
      await this.db.query(
        `INSERT INTO order_history
           (company_id, entity_type, event_type, order_id, order_number, description)
         VALUES ($1, 'order', 'customer_emailed', $2, $3, $4)`,
        [
          row.company_id,
          row.order_id,
          row.order_number,
          `${verb} invoice ${row.invoice_number} to ${recipient}.`
        ]
      );
    } catch {
      /* history is non-critical */
    }
  }
}

/** Keep the attachment name to characters every mail client and OS accepts. */
function sanitiseFilename(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "invoice";
}
