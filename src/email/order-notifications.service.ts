import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { EmailService } from "./email.service";
import {
  composeOrderCompletionEmail,
  type OrderCompletionEmailData,
  type OrderCompletionStatus
} from "./email-templates";

// ════════════════════════════════════════════════════════════════
// ORDER-COMPLETION CUSTOMER NOTIFICATIONS
//
// Sends the customer one email the first time their order reaches a "done or
// above" status (completed / ready_for_shipping / out_for_shipping / fulfilled).
//
// WHY A SWEEP (not an inline hook in updateOrder): an order reaches these
// statuses mainly through the piece-derived rollup recomputeOrderStatusTx —
// driven by the clock (TimeStateService auto-completing print windows) and by
// several piece/bed operations — NOT through updateOrder's status path. A
// status-change hook there would miss the most common route to "completed". A
// periodic sweep over the orders table catches every order regardless of how it
// got there, and is naturally idempotent + restart-safe.
//
// Idempotency + audit live in order_emails (see migrations/..._order_emails.sql):
// an order is eligible only while it has no settled ('sent'/'dry_run'/'skipped')
// completion row. Transport failures are logged but NOT recorded, so the order
// stays eligible and retries next sweep (mirrors FilePurgeService).
//
// Tunables (env):
//   EMAIL_ENABLED            "true" to attempt real delivery; else dry-run
//   EMAIL_SWEEP_INTERVAL_MS  sweep cadence (default 2 min)
// ════════════════════════════════════════════════════════════════

// Trigger range: an order emails the customer the first time it reaches
// "ready for shipping or above". 'completed' (production done, not yet packed)
// deliberately does NOT notify — the customer hears from us once the order is
// actually ready to ship and onward through fulfilment.
const NOTIFY_STATUSES = [
  "ready_for_shipping",
  "out_for_shipping",
  "fulfilled"
] as const;

const EMAIL_TYPE = "order_completion";

type EligibleRow = {
  order_id: string;
  company_id: string;
  customer_id: string | null;
  order_number: string;
  title: string;
  description: string | null;
  status: OrderCompletionStatus;
  established_at: string | null;
  deadline: string | null;
  profit_pct: string | null;
  piece_count: string;
  pieces_cost: string | null;
  company_name: string;
  company_phone: string | null;
  company_email: string | null;
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
  secondary_phone: string | null;
  customer_deleted_at: string | null;
  display_name: string | null;
};

@Injectable()
export class OrderNotificationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("OrderNotificationsService");
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly sweepIntervalMs: number;

  constructor(
    private readonly db: DatabaseService,
    private readonly email: EmailService
  ) {
    this.sweepIntervalMs = this.readPositiveInt(
      process.env.EMAIL_SWEEP_INTERVAL_MS,
      2 * 60 * 1000
    );
  }

  onModuleInit(): void {
    // Boot breadcrumb: positively confirms the sweep is loaded, whether real
    // delivery is on (EMAIL_ENABLED), and the cadence — so "is it even running?"
    // is answerable from the deploy logs without guessing.
    this.logger.log(
      `order-email sweep armed (live=${this.email.isLiveDelivery}, interval=${this.sweepIntervalMs}ms)`
    );
    // First sweep shortly after boot, then on the configured cadence.
    setTimeout(() => void this.tick(), 20_000);
    this.timer = setInterval(() => void this.tick(), this.sweepIntervalMs);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One sweep. Re-entrancy-guarded so a slow tick can't overlap itself. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const orders = await this.findEligibleOrders();
      if (orders.length === 0) return;

      let sent = 0;
      let skipped = 0;
      let failed = 0;

      for (const order of orders) {
        const outcome = await this.notifyOrder(order);
        if (outcome === "sent" || outcome === "dry_run") sent += 1;
        else if (outcome === "skipped") skipped += 1;
        else failed += 1;
      }

      if (sent + skipped + failed > 0) {
        const verb = this.email.isLiveDelivery ? "sent" : "dry-run composed";
        this.logger.log(
          `order-emails: ${verb} ${sent} completion email(s), ` +
            `skipped ${skipped} (no recipient), ${failed} failed`
        );
      }
    } catch (e) {
      this.logger.warn(`order-emails tick failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Orders at a "done or above" status with no settled completion email yet. The
   * NOT EXISTS guard makes the sweep self-limiting: once an order has a
   * sent/dry_run/skipped row it drops out, so neither the historical backlog
   * (suppressed by the migration backfill) nor already-emailed orders are
   * re-scanned forever. Capped per sweep; the next tick continues any remainder.
   */
  private async findEligibleOrders(): Promise<EligibleRow[]> {
    const res = await this.db.query<EligibleRow>(
      `SELECT
          o.order_id, o.company_id, o.customer_id, o.order_number, o.title,
          o.description, o.status, o.established_at, o.deadline, o.profit_pct,
          comp.name            AS company_name,
          comp.phone           AS company_phone,
          comp.owner_email     AS company_email,
          comp.website         AS company_website,
          comp.city            AS company_city,
          comp.country_code    AS company_country,
          comp.currency_default AS company_currency,
          c.customer_type, c.first_name, c.last_name, c.business_name,
          c.email              AS customer_email,
          c.phone              AS customer_phone,
          c.secondary_phone, c.deleted_at AS customer_deleted_at,
          CASE
            WHEN c.customer_type = 'b2b' THEN c.business_name
            ELSE concat_ws(' ', c.first_name, c.last_name)
          END                  AS display_name,
          (SELECT COUNT(*) FROM order_pieces op
            WHERE op.company_id = o.company_id AND op.order_id = o.order_id) AS piece_count,
          (SELECT SUM(op.cost) FROM order_pieces op
            WHERE op.company_id = o.company_id AND op.order_id = o.order_id) AS pieces_cost
         FROM orders o
         JOIN companies comp ON comp.company_id = o.company_id
         LEFT JOIN customers c ON c.customer_id = o.customer_id
        WHERE o.status = ANY($1::text[])
          AND NOT EXISTS (
            SELECT 1 FROM order_emails e
             WHERE e.company_id = o.company_id
               AND e.order_id = o.order_id
               AND e.email_type = $2
               AND e.status IN ('sent', 'dry_run', 'skipped')
          )
        ORDER BY o.last_updated_at ASC
        LIMIT 100`,
      [[...NOTIFY_STATUSES], EMAIL_TYPE]
    );
    return res.rows;
  }

  /**
   * Compose + send (or skip) one order's completion email and record the outcome
   * in order_emails. A 'skipped' row is recorded for orders with no deliverable
   * recipient so they stop being re-scanned. A transport failure is logged and
   * left UNrecorded so the order retries next sweep.
   */
  private async notifyOrder(
    row: EligibleRow
  ): Promise<"sent" | "dry_run" | "skipped" | "failed"> {
    const recipient = this.resolveRecipient(row);

    if (!recipient) {
      await this.recordEmail(row, {
        status: "skipped",
        recipientEmail: row.customer_email,
        error: this.skipReason(row)
      });
      return "skipped";
    }

    const message = composeOrderCompletionEmail(this.toEmailData(row, recipient));

    let result: "sent" | "dry_run";
    try {
      result = await this.email.send({
        to: recipient,
        subject: message.subject,
        text: message.text,
        html: message.html
      });
    } catch (e) {
      // Leave the order un-recorded so it stays eligible and retries next sweep.
      this.logger.warn(
        `order-emails: delivery failed for order #${row.order_number}: ${(e as Error).message}`
      );
      return "failed";
    }

    await this.recordEmail(row, {
      status: result,
      recipientEmail: recipient,
      subject: message.subject,
      body: message.text
    });
    await this.logHistory(row, recipient, result);
    return result;
  }

  /** The email we can actually deliver to, or null if there is none. */
  private resolveRecipient(row: EligibleRow): string | null {
    if (!row.customer_id || row.customer_deleted_at) return null;
    const email = (row.customer_email ?? "").trim();
    return email.length > 0 ? email : null;
  }

  private skipReason(row: EligibleRow): string {
    if (!row.customer_id) return "order has no customer attached";
    if (row.customer_deleted_at) return "customer has been deleted";
    return "customer has no email on file";
  }

  /** Map a DB row into the shape the template expects. */
  private toEmailData(row: EligibleRow, recipient: string): OrderCompletionEmailData {
    const contactName = [row.first_name, row.last_name]
      .filter((p): p is string => !!p && p.trim().length > 0)
      .join(" ")
      .trim();
    const piecesCost = row.pieces_cost != null ? Number(row.pieces_cost) : NaN;
    const profit = row.profit_pct != null ? Number(row.profit_pct) : 0;
    const total =
      Number.isFinite(piecesCost)
        ? Math.round(piecesCost * (1 + (Number.isFinite(profit) ? profit : 0) / 100) * 100) / 100
        : null;

    return {
      company: {
        name: row.company_name,
        phone: row.company_phone,
        email: row.company_email,
        website: row.company_website,
        city: row.company_city,
        countryCode: row.company_country,
        currency: row.company_currency
      },
      customer: {
        displayName: (row.display_name ?? "").trim() || "Customer",
        contactName: contactName.length > 0 ? contactName : null,
        phone: row.customer_phone,
        secondaryPhone: row.secondary_phone,
        email: recipient,
        isBusiness: row.customer_type === "b2b",
        businessName: row.business_name
      },
      order: {
        orderNumber: row.order_number,
        title: row.title,
        description: row.description,
        status: row.status,
        establishedAt: row.established_at,
        deadline: row.deadline,
        pieceCount: Number(row.piece_count) || 0,
        total
      }
    };
  }

  /**
   * Persist the email outcome. ON CONFLICT DO NOTHING makes a double-send race
   * (two sweeps overlapping) a no-op. Best-effort: a record failure must not
   * crash the sweep — but note an un-recorded 'sent' would re-send next tick, so
   * we surface record failures loudly.
   */
  private async recordEmail(
    row: EligibleRow,
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
        `INSERT INTO order_emails
           (company_id, order_id, customer_id, email_type, recipient_email,
            subject, body, status, error, order_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (company_id, order_id, email_type) DO NOTHING`,
        [
          row.company_id,
          row.order_id,
          row.customer_id,
          EMAIL_TYPE,
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
        `order-emails: failed to record ${detail.status} for order #${row.order_number}: ${(e as Error).message}`
      );
    }
  }

  /** Best-effort breadcrumb on the shared order_history feed. */
  private async logHistory(
    row: EligibleRow,
    recipient: string,
    result: "sent" | "dry_run"
  ): Promise<void> {
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
          `${verb} order-completion email to ${recipient} (order ${row.status}).`
        ]
      );
    } catch {
      /* history is non-critical */
    }
  }

  private readPositiveInt(raw: string | undefined, fallback: number): number {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  }
}
