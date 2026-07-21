import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { emailAppUrl } from "../email/app-url";
import { EmailService } from "../email/email.service";
import {
  composeLicenseNoticeEmail,
  type LicenseNoticeKind
} from "../email/email-templates";
import { LicensingService } from "./licensing.service";

// ════════════════════════════════════════════════════════════════
// OWNER LICENSE NOTIFICATIONS
//
// Emails the WORKSPACE OWNER as their trial or paid period approaches its end
// and again once it lapses — the licensing counterpart of the customer-facing
// OrderNotificationsService, sharing its architecture end to end:
//
//   · a self-scheduling setInterval sweep (re-entrancy-guarded, restart-safe)
//   · idempotency + audit in a ledger table (license_emails), keyed on
//     (company_id, email_type, period_anchor) — the anchor is the billing
//     cycle's current_period_end, so extending/renewing re-arms the ladder
//   · transport failures logged but NOT recorded, so the notice retries
//   · EMAIL_ENABLED gates real delivery (dry-run otherwise)
//
// The notice LADDER per subscription:
//
//   trial   trial_ending_7d → _3d → _1d → trial_ended        (no grace)
//   paid    renewal_due_14d → _7d → _1d → plan_lapsed → plan_readonly
//
// Only the FURTHEST-ALONG due rung sends; earlier unsent rungs are recorded
// as skipped/superseded, so a workspace never gets three reminders at once
// after downtime — and the pre-existing backlog at rollout is suppressed the
// same way (terminal rungs older than the lookback are skipped as stale).
//
// Skipped entirely: subscriptions with no period end (indefinite manual or
// grant access), soft-deleted companies, and suspended/banned companies
// (moderation already owns that conversation).
//
// Tunables (env):
//   LICENSE_NOTICES_ENABLED         kill switch; anything but "false" = on
//   LICENSE_NOTICE_SWEEP_INTERVAL_MS  sweep cadence (default 6h)
//   LICENSE_NOTICE_LOOKBACK_DAYS    how far past a terminal rung we still
//                                   send rather than skip as stale (default 10)
//   EMAIL_ENABLED                   "true" to actually deliver; else dry-run
// ════════════════════════════════════════════════════════════════

const DAY_MS = 24 * 60 * 60 * 1000;

type NoticeType =
  | "trial_ending_7d"
  | "trial_ending_3d"
  | "trial_ending_1d"
  | "trial_ended"
  | "renewal_due_14d"
  | "renewal_due_7d"
  | "renewal_due_1d"
  | "plan_lapsed"
  | "plan_readonly";

interface CandidateRow {
  company_id: string;
  plan_code: string;
  status: string;
  source: string;
  current_period_end: string | Date;
  plan_name: string;
  company_name: string;
  owner_email: string | null;
}

interface Rung {
  type: NoticeType;
  kind: LicenseNoticeKind;
  due: boolean;
  /** Terminal rungs only: too old to still be worth sending. */
  stale: boolean;
}

@Injectable()
export class LicenseNotificationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("LicenseNotificationsService");
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private warnedMissingTable = false;

  private readonly enabled: boolean;
  private readonly sweepIntervalMs: number;
  private readonly lookbackMs: number;

  constructor(
    private readonly db: DatabaseService,
    private readonly email: EmailService,
    private readonly licensing: LicensingService
  ) {
    this.enabled = (process.env.LICENSE_NOTICES_ENABLED ?? "").toLowerCase() !== "false";
    this.sweepIntervalMs = this.readPositiveInt(
      process.env.LICENSE_NOTICE_SWEEP_INTERVAL_MS,
      6 * 60 * 60 * 1000
    );
    this.lookbackMs =
      this.readPositiveInt(process.env.LICENSE_NOTICE_LOOKBACK_DAYS, 10) * DAY_MS;
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log("license-notice sweep disabled (LICENSE_NOTICES_ENABLED=false)");
      return;
    }
    this.logger.log(
      `license-notice sweep armed (live=${this.email.isLiveDelivery}, interval=${this.sweepIntervalMs}ms)`
    );
    // First sweep shortly after boot, then on the configured cadence.
    setTimeout(() => void this.tick(), 40_000);
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
      const candidates = await this.findCandidates();
      if (candidates.length === 0) return;

      const settled = await this.loadSettled(candidates.map((c) => c.company_id));

      let sent = 0;
      let skipped = 0;
      let failed = 0;

      for (const row of candidates) {
        const outcome = await this.notifyCompany(row, settled);
        if (outcome === "sent" || outcome === "dry_run") sent += 1;
        else if (outcome === "skipped") skipped += 1;
        else if (outcome === "failed") failed += 1;
      }

      if (sent + skipped + failed > 0) {
        const verb = this.email.isLiveDelivery ? "sent" : "dry-run composed";
        this.logger.log(
          `license-notices: ${verb} ${sent} owner notice(s), skipped ${skipped}, ${failed} failed`
        );
      }
    } catch (e) {
      const code = typeof e === "object" && e !== null ? (e as { code?: string }).code : undefined;
      if (code === "42P01") {
        // license_emails not migrated yet — warn once, stay quiet after.
        if (!this.warnedMissingTable) {
          this.warnedMissingTable = true;
          this.logger.warn(
            "license-notices: license_emails table missing (migration not applied) — sweep idle until it exists"
          );
        }
        return;
      }
      this.logger.warn(`license-notices tick failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Subscriptions whose period end is close enough (ahead) or recent enough
   * (behind) to possibly owe a notice. The 60-day tail covers the latest rung
   * (plan_readonly at end + graceDays) plus the stale lookback with room to
   * spare; anything older can only ever produce skip records, so excluding it
   * keeps the sweep self-limiting. Deleted and suspended/banned companies are
   * out of scope — moderation owns that conversation.
   */
  private async findCandidates(): Promise<CandidateRow[]> {
    const base = `
      SELECT cs.company_id, cs.plan_code, cs.status, cs.source, cs.current_period_end,
             p.display_name AS plan_name,
             c.name AS company_name, c.owner_email
        FROM company_subscriptions cs
        JOIN plans p ON p.plan_code = cs.plan_code
        JOIN companies c ON c.company_id = cs.company_id
       WHERE cs.current_period_end IS NOT NULL
         AND cs.current_period_end BETWEEN now() - INTERVAL '60 days'
                                       AND now() + INTERVAL '15 days'`;
    try {
      const res = await this.db.query<CandidateRow>(
        `${base}
         AND c.deleted_at IS NULL
         AND (c.admin_hold IS NULL OR c.admin_hold = 'grace')
       ORDER BY cs.current_period_end ASC
       LIMIT 300`
      );
      return res.rows;
    } catch (err) {
      // Admin-control columns not migrated yet (undefined column) — sweep
      // without the moderation filters rather than not at all.
      if ((err as { code?: string }).code !== "42703") throw err;
      const res = await this.db.query<CandidateRow>(
        `${base}
       ORDER BY cs.current_period_end ASC
       LIMIT 300`
      );
      return res.rows;
    }
  }

  /**
   * Every settled (sent/dry_run/skipped) notice for the candidate companies,
   * as a "companyId|type|anchorMs" set — one query instead of one per company.
   */
  private async loadSettled(companyIds: string[]): Promise<Set<string>> {
    const res = await this.db.query<{
      company_id: string;
      email_type: string;
      period_anchor: string | Date;
    }>(
      `SELECT company_id, email_type, period_anchor
         FROM license_emails
        WHERE company_id = ANY($1::uuid[])`,
      [companyIds]
    );
    const set = new Set<string>();
    for (const r of res.rows) {
      set.add(this.settleKey(r.company_id, r.email_type, new Date(r.period_anchor).getTime()));
    }
    return set;
  }

  private settleKey(companyId: string, type: string, anchorMs: number): string {
    return `${companyId}|${type}|${anchorMs}`;
  }

  /**
   * The full notice ladder for one subscription, oldest rung first. `due`
   * marks every rung whose moment has arrived; the caller sends only the LAST
   * due rung and records the earlier ones as superseded.
   */
  private buildLadder(row: CandidateRow, endMs: number, now: number): Rung[] {
    const daysLeft = Math.ceil((endMs - now) / DAY_MS);
    const isTrial = row.status === "trialing" || row.source === "trial";

    if (isTrial) {
      return [
        { type: "trial_ending_7d", kind: "trial_ending", due: daysLeft <= 7, stale: false },
        { type: "trial_ending_3d", kind: "trial_ending", due: daysLeft <= 3, stale: false },
        { type: "trial_ending_1d", kind: "trial_ending", due: daysLeft <= 1, stale: false },
        {
          type: "trial_ended",
          kind: "trial_ended",
          due: now >= endMs,
          stale: now > endMs + this.lookbackMs
        }
      ];
    }

    // Paid / granted access with a hard end date. Pre-end reminders only make
    // sense while the plan is still active — a canceled/revoked subscription
    // is ALREADY lapsed (its period end is the cancel moment), so it goes
    // straight to the lapse rungs.
    const active = row.status === "active";
    const graceEndMs = endMs + this.licensing.graceDays * DAY_MS;
    return [
      { type: "renewal_due_14d", kind: "renewal_due", due: active && daysLeft <= 14, stale: false },
      { type: "renewal_due_7d", kind: "renewal_due", due: active && daysLeft <= 7, stale: false },
      { type: "renewal_due_1d", kind: "renewal_due", due: active && daysLeft <= 1, stale: false },
      {
        type: "plan_lapsed",
        kind: "plan_lapsed",
        due: now >= endMs,
        // Once the grace window itself is over, plan_readonly is the message.
        stale: now >= graceEndMs
      },
      {
        type: "plan_readonly",
        kind: "plan_readonly",
        due: now >= graceEndMs,
        stale: now > graceEndMs + this.lookbackMs
      }
    ];
  }

  /**
   * Resolve + send (or skip-record) the one notice this subscription owes
   * right now. Returns what happened for the sweep tally; "quiet" = nothing
   * was due.
   */
  private async notifyCompany(
    row: CandidateRow,
    settled: Set<string>
  ): Promise<"sent" | "dry_run" | "skipped" | "failed" | "quiet"> {
    const now = Date.now();
    const endMs = new Date(row.current_period_end).getTime();
    if (!Number.isFinite(endMs)) return "quiet";
    const anchorIso = new Date(endMs).toISOString();

    const ladder = this.buildLadder(row, endMs, now);
    const due = ladder.filter(
      (r) => r.due && !settled.has(this.settleKey(row.company_id, r.type, endMs))
    );
    if (due.length === 0) return "quiet";

    const target = due[due.length - 1]!;

    // Earlier unsent rungs are history the moment a later rung is due —
    // record them so they stop being scanned and can never fire late.
    for (const rung of due.slice(0, -1)) {
      await this.record(row, rung.type, anchorIso, {
        status: "skipped",
        error: `superseded by ${target.type}`
      });
    }

    if (target.stale) {
      await this.record(row, target.type, anchorIso, {
        status: "skipped",
        error: "stale at sweep time (past the notice lookback window)"
      });
      return "skipped";
    }

    const recipient = (row.owner_email ?? "").trim();
    if (!recipient) {
      await this.record(row, target.type, anchorIso, {
        status: "skipped",
        error: "company has no owner email on file"
      });
      return "skipped";
    }

    const daysLeft = Math.max(0, Math.ceil((endMs - now) / DAY_MS));
    const graceUntil =
      target.kind === "renewal_due" || target.kind === "plan_lapsed"
        ? new Date(endMs + this.licensing.graceDays * DAY_MS).toISOString()
        : null;

    const message = composeLicenseNoticeEmail({
      kind: target.kind,
      companyName: row.company_name,
      planName: row.plan_name,
      periodEnd: anchorIso,
      daysLeft: endMs > now ? daysLeft : null,
      graceUntil,
      graceDays: this.licensing.graceDays,
      appUrl: this.appUrl()
    });

    let result: "sent" | "dry_run";
    try {
      result = await this.email.send({
        to: recipient,
        subject: message.subject,
        text: message.text,
        html: message.html
      });
    } catch (e) {
      // Leave un-recorded so this rung stays eligible and retries next sweep.
      this.logger.warn(
        `license-notices: delivery failed for ${row.company_name} (${target.type}): ${(e as Error).message}`
      );
      return "failed";
    }

    await this.record(row, target.type, anchorIso, {
      status: result,
      recipientEmail: recipient,
      subject: message.subject,
      body: message.text
    });
    return result;
  }

  /**
   * Persist one ledger row. ON CONFLICT DO NOTHING makes overlapping sweeps a
   * no-op; a record failure after a real send is surfaced loudly because an
   * un-recorded 'sent' would re-send next tick.
   */
  private async record(
    row: CandidateRow,
    type: NoticeType,
    anchorIso: string,
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
        `INSERT INTO license_emails
           (company_id, email_type, period_anchor, recipient_email, subject, body, status, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (company_id, email_type, period_anchor) DO NOTHING`,
        [
          row.company_id,
          type,
          anchorIso,
          detail.recipientEmail ?? null,
          detail.subject ?? null,
          detail.body ?? null,
          detail.status,
          detail.error ?? null
        ]
      );
    } catch (e) {
      this.logger.warn(
        `license-notices: failed to record ${detail.status} ${type} for ${row.company_name}: ${(e as Error).message}`
      );
    }
  }

  /** Platform origin the notice CTA links to — the one canonical public app
   *  address (see email/app-url.ts; never a CORS/preview origin). */
  private appUrl(): string {
    return emailAppUrl();
  }

  private readPositiveInt(raw: string | undefined, fallback: number): number {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  }
}
