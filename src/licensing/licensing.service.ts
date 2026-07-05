import { ForbiddenException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomBytes } from "node:crypto";
import { DatabaseService, type SqlExecutor } from "../database/database.service";

// ════════════════════════════════════════════════════════════════
// Licensing — resolves every company to one effective state:
//
//   ok        plan valid, under its printer cap        → nothing blocked
//   grace     plan lapsed OR over the printer cap      → printer adds blocked
//   readonly  the grace window (LICENSE_GRACE_DAYS,    → all mutations blocked
//             default 14 days) has run out                (LicenseGuard)
//
// Plan caps live in the `plans` table (data, not code). Enforcement is
// gated behind LICENSING_ENFORCED: until it is "true", every state is
// computed and exposed (status endpoint, /auth/me, client banners) but
// nothing is ever blocked — the same dry-run-first pattern as
// PURGE_ENABLED / EMAIL_ENABLED.
// ════════════════════════════════════════════════════════════════

export type LicenseState = "ok" | "grace" | "readonly";
export type LicenseReason = "expired" | "canceled" | "revoked" | "over_limit" | null;

export interface LicenseStatus {
  plan_code: string;
  plan_name: string;
  /** NULL = unlimited printers. */
  max_printers: number | null;
  printer_count: number;
  /** Raw subscription status: trialing | active | canceled | revoked. */
  status: string;
  /** How the plan was obtained: trial | manual | grant_code | stripe. */
  source: string;
  current_period_end: string | null;
  state: LicenseState;
  reason: LicenseReason;
  /** When the grace window lapses into read-only (set while state != ok). */
  grace_until: string | null;
  /** Whether the gate actually blocks (LICENSING_ENFORCED). */
  enforced: boolean;
}

interface SubscriptionRow {
  company_id: string;
  plan_code: string;
  status: string;
  source: string;
  current_period_end: string | Date | null;
  limit_exceeded_since: string | Date | null;
  updated_at: string | Date;
  plan_name: string;
  max_printers: number | null;
}

// Resolved licenses are cached briefly (like the auth guard's profile cache)
// so the global LicenseGuard doesn't add a query to every mutation. Redeem /
// admin writes invalidate explicitly, so the window only delays *external*
// lapses (trial running out) by at most a minute.
const LICENSE_TTL_MS = 60_000;

const DAY_MS = 24 * 60 * 60 * 1000;

// Grant-code alphabet: no 0/O/1/I/L so codes survive being read aloud.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

@Injectable()
export class LicensingService {
  private readonly logger = new Logger(LicensingService.name);
  private readonly cache = new Map<string, { value: LicenseStatus; expiresAt: number }>();

  readonly enforced: boolean;
  readonly trialDays: number;
  readonly graceDays: number;
  private readonly adminEmails: Set<string>;

  constructor(
    private readonly db: DatabaseService,
    config: ConfigService
  ) {
    this.enforced = config.get<string>("LICENSING_ENFORCED") === "true";
    this.trialDays = Number(config.get<string>("LICENSE_TRIAL_DAYS") ?? 14) || 14;
    this.graceDays = Number(config.get<string>("LICENSE_GRACE_DAYS") ?? 14) || 14;
    this.adminEmails = new Set(
      (config.get<string>("PLATFORM_ADMIN_EMAILS") ?? "")
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean)
    );
  }

  /** Platform-admin allowlist check (PLATFORM_ADMIN_EMAILS, comma-separated). */
  isPlatformAdminEmail(email: string | null | undefined): boolean {
    return !!email && this.adminEmails.has(email.trim().toLowerCase());
  }

  invalidate(companyId: string): void {
    this.cache.delete(companyId);
  }

  /**
   * Effective license for a company (cached ~60s). Fails OPEN: any resolver
   * error (including the licensing tables not being migrated yet) logs a
   * warning and returns a permissive "ok" status, so licensing can never
   * take the product down.
   */
  async getStatus(companyId: string, skipCache = false): Promise<LicenseStatus> {
    if (!skipCache) {
      const hit = this.cache.get(companyId);
      if (hit) {
        if (hit.expiresAt > Date.now()) return hit.value;
        this.cache.delete(companyId);
      }
    }

    try {
      const status = await this.resolve(companyId);
      this.cache.set(companyId, { value: status, expiresAt: Date.now() + LICENSE_TTL_MS });
      return status;
    } catch (err) {
      this.logger.warn(
        `License resolution failed for company ${companyId} — failing open: ${err instanceof Error ? err.message : err}`
      );
      return {
        plan_code: "unknown",
        plan_name: "Unknown",
        max_printers: null,
        printer_count: 0,
        status: "active",
        source: "manual",
        current_period_end: null,
        state: "ok",
        reason: null,
        grace_until: null,
        enforced: this.enforced
      };
    }
  }

  private async resolve(companyId: string): Promise<LicenseStatus> {
    let sub = await this.loadSubscription(companyId);
    if (!sub) {
      // Lazy provisioning: a company with no licensing row (created before
      // the app wrote trials at setup, or a race) starts its trial now.
      await this.ensureTrial(companyId);
      sub = await this.loadSubscription(companyId);
      if (!sub) throw new Error("subscription row missing after trial provisioning");
    }

    const countResult = await this.db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM printer_instances WHERE company_id = $1",
      [companyId]
    );
    const printerCount = Number(countResult.rows[0]?.count ?? 0);

    const now = Date.now();
    const periodEnd = sub.current_period_end ? new Date(sub.current_period_end).getTime() : null;

    // Condition 1 — the plan itself lapsed (trial/paid period ended, or the
    // subscription was canceled / its grant code revoked). Cancel/revoke set
    // current_period_end to the moment they happened, so it doubles as the
    // grace anchor; updated_at is the backstop if it's ever missing.
    const lapsed =
      sub.status === "canceled" ||
      sub.status === "revoked" ||
      (periodEnd !== null && now > periodEnd);
    const lapseAnchor = periodEnd ?? new Date(sub.updated_at).getTime();

    // Condition 2 — over the printer cap (downgrade landed a company above
    // its new limit). The first resolution that sees it stamps
    // limit_exceeded_since; dropping back under clears it.
    const overLimit = sub.max_printers !== null && printerCount > sub.max_printers;
    let overSince = sub.limit_exceeded_since
      ? new Date(sub.limit_exceeded_since).getTime()
      : null;
    if (overLimit && overSince === null) {
      overSince = now;
      await this.db.query(
        "UPDATE company_subscriptions SET limit_exceeded_since = now(), updated_at = now() WHERE company_id = $1",
        [companyId]
      );
    } else if (!overLimit && overSince !== null) {
      overSince = null;
      await this.db.query(
        "UPDATE company_subscriptions SET limit_exceeded_since = NULL, updated_at = now() WHERE company_id = $1",
        [companyId]
      );
    }

    // Whichever condition's grace window lapses first wins.
    let state: LicenseState = "ok";
    let reason: LicenseReason = null;
    let graceUntil: number | null = null;

    if (lapsed || overLimit) {
      const anchors: { anchor: number; reason: Exclude<LicenseReason, null> }[] = [];
      if (lapsed) {
        anchors.push({
          anchor: lapseAnchor,
          reason:
            sub.status === "revoked" ? "revoked" :
            sub.status === "canceled" ? "canceled" : "expired"
        });
      }
      if (overLimit && overSince !== null) {
        anchors.push({ anchor: overSince, reason: "over_limit" });
      }
      anchors.sort((a, b) => a.anchor - b.anchor);
      const first = anchors[0]!;
      graceUntil = first.anchor + this.graceDays * DAY_MS;
      reason = first.reason;
      state = now < graceUntil ? "grace" : "readonly";
    }

    return {
      plan_code: sub.plan_code,
      plan_name: sub.plan_name,
      max_printers: sub.max_printers,
      printer_count: printerCount,
      status: sub.status,
      source: sub.source,
      current_period_end: sub.current_period_end
        ? new Date(sub.current_period_end).toISOString()
        : null,
      state,
      reason,
      grace_until: graceUntil ? new Date(graceUntil).toISOString() : null,
      enforced: this.enforced
    };
  }

  private async loadSubscription(companyId: string): Promise<SubscriptionRow | null> {
    const { rows } = await this.db.query<SubscriptionRow>(
      `SELECT cs.company_id, cs.plan_code, cs.status, cs.source,
              cs.current_period_end, cs.limit_exceeded_since, cs.updated_at,
              p.display_name AS plan_name, p.max_printers
       FROM company_subscriptions cs
       JOIN plans p ON p.plan_code = cs.plan_code
       WHERE cs.company_id = $1`,
      [companyId]
    );
    return rows[0] ?? null;
  }

  /**
   * Starts the company's trial if it has no licensing row yet. Safe to call
   * repeatedly (ON CONFLICT DO NOTHING) and safe pre-migration (the caller
   * swallows failures) — signup must never break on licensing.
   */
  async ensureTrial(companyId: string, executor?: SqlExecutor): Promise<void> {
    await this.db.query(
      `INSERT INTO company_subscriptions (company_id, plan_code, status, source, current_period_end)
       VALUES ($1, 'trial', 'trialing', 'trial', now() + make_interval(days => $2))
       ON CONFLICT (company_id) DO NOTHING`,
      [companyId, this.trialDays],
      executor
    );
  }

  /**
   * Gate for adding a printer. Called inside the printer-create transaction,
   * after the caller has taken the per-company advisory lock, so two
   * concurrent adds can't both slip under the cap. Blocks when the plan has
   * lapsed or the cap is already reached; in grace the cap check still
   * applies (grace only preserves day-to-day work, never expansion).
   * Dry-run (LICENSING_ENFORCED unset) logs instead of blocking.
   */
  async assertCanAddPrinter(companyId: string, executor: SqlExecutor): Promise<void> {
    let status: LicenseStatus;
    try {
      status = await this.resolve(companyId);
    } catch (err) {
      this.logger.warn(
        `Printer-cap check failed for company ${companyId} — failing open: ${err instanceof Error ? err.message : err}`
      );
      return;
    }

    let blockMessage: string | null = null;

    if (status.state === "readonly" || (status.reason && status.reason !== "over_limit")) {
      blockMessage =
        status.status === "trialing"
          ? "Your trial has ended. Choose a plan to keep adding printers."
          : "Your plan is no longer active. Renew your plan to keep adding printers.";
    } else if (status.max_printers !== null) {
      // Recount inside the caller's transaction (post-advisory-lock) so the
      // decision is race-free even against the cached resolver count.
      const { rows } = await this.db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM printer_instances WHERE company_id = $1",
        [companyId],
        executor
      );
      const current = Number(rows[0]?.count ?? 0);
      if (current + 1 > status.max_printers) {
        blockMessage = `Your ${status.plan_name} plan includes up to ${status.max_printers} printers and you already have ${current}. Upgrade your plan to add more.`;
      }
    }

    if (!blockMessage) return;

    if (!this.enforced) {
      this.logger.log(
        `[dry-run] Would block printer add for company ${companyId}: ${blockMessage}`
      );
      return;
    }
    throw new ForbiddenException(blockMessage);
  }

  /** Mint an unambiguous grant code like PX-7K2M-Q4TC-9WHB. */
  generateGrantCode(): string {
    const bytes = randomBytes(12);
    let raw = "";
    for (let i = 0; i < 12; i++) {
      raw += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
    }
    return `PX-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  }
}
