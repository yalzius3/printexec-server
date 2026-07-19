import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post
} from "@nestjs/common";
import { UserId } from "../common/user-id.decorator";
import { parseWithSchema } from "../common/zod";
import { DatabaseService } from "../database/database.service";
import { EmailService } from "../email/email.service";
import { composePlatformEmail } from "../email/email-templates";
import { LicenseExempt } from "./license-exempt.decorator";
import {
  adminEmailSchema,
  assignPlanSchema,
  bulkAssignSchema,
  bulkEndTrialSchema,
  bulkExtendSchema,
  bulkHoldSchema,
  bulkMessageSchema,
  companyRefSchema,
  createGrantSchema,
  endTrialSchema,
  sendMessageSchema,
  setHoldSchema
} from "./licensing.schemas";
import { LicensingService } from "./licensing.service";

// ════════════════════════════════════════════════════════════════
// Platform-owner licensing admin. NOT tenant-scoped: these endpoints see and
// modify every company's plan, so access is limited to the email allowlist
// in PLATFORM_ADMIN_EMAILS (asserted per-request against the authenticated
// user — there is no platform-admin role in the tenant model).
// @LicenseExempt so an admin is never blocked by their own company's state.
// ════════════════════════════════════════════════════════════════

/** Replace {{name}} placeholders; unknown names are left as-is. */
function substituteVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => vars[key] ?? match);
}

@LicenseExempt()
@Controller("licensing/admin")
export class LicensingAdminController {
  constructor(
    private readonly licensing: LicensingService,
    private readonly db: DatabaseService,
    private readonly email: EmailService
  ) {}

  // Every company with its plan, state anchors, printer count, and any grant
  // code backing its access. Three query tiers so the area loads on any
  // migration level: full (notice ledger + checkout intent) → admin-controls
  // only → base.
  @Get("overview")
  async overview(@UserId() userId: string) {
    await this.assertPlatformAdmin(userId);

    const errCode = (err: unknown) =>
      typeof err === "object" && err !== null ? (err as { code?: string }).code : undefined;

    // Tier 1 — everything, including the latest license_emails entry (what the
    // owner was last told) and the checkout intent recorded at signup.
    try {
      const { rows } = await this.db.query(
        `SELECT
           c.company_id,
           c.name,
           c.owner_email,
           cs.plan_code,
           p.display_name AS plan_name,
           p.max_printers,
           cs.status,
           cs.source,
           cs.current_period_end,
           cs.limit_exceeded_since,
           cs.selected_plan_code,
           g.code AS grant_code,
           c.admin_hold,
           c.admin_hold_reason,
           c.deleted_at,
           (SELECT count(*)::int FROM printer_instances pi WHERE pi.company_id = c.company_id) AS printer_count,
           (SELECT count(*)::int FROM company_admin_messages m
              WHERE m.company_id = c.company_id AND m.dismissed_at IS NULL) AS unread_messages,
           (SELECT jsonb_build_object(
                     'email_type', le.email_type,
                     'status', le.status,
                     'created_at', le.created_at)
              FROM license_emails le
             WHERE le.company_id = c.company_id
             ORDER BY le.created_at DESC
             LIMIT 1) AS last_notice
         FROM companies c
         LEFT JOIN company_subscriptions cs ON cs.company_id = c.company_id
         LEFT JOIN plans p ON p.plan_code = cs.plan_code
         LEFT JOIN license_grants g ON g.grant_id = cs.grant_id
         ORDER BY c.deleted_at NULLS FIRST, c.name`
      );
      return rows;
    } catch (err) {
      if (errCode(err) !== "42703" && errCode(err) !== "42P01") throw err;
    }

    // Tier 2 — admin-control columns exist but the notice ledger / intent
    // column doesn't yet (2026-07-19 migration not applied).
    try {
      const { rows } = await this.db.query(
        `SELECT
           c.company_id,
           c.name,
           c.owner_email,
           cs.plan_code,
           p.display_name AS plan_name,
           p.max_printers,
           cs.status,
           cs.source,
           cs.current_period_end,
           cs.limit_exceeded_since,
           g.code AS grant_code,
           c.admin_hold,
           c.admin_hold_reason,
           c.deleted_at,
           (SELECT count(*)::int FROM printer_instances pi WHERE pi.company_id = c.company_id) AS printer_count,
           (SELECT count(*)::int FROM company_admin_messages m
              WHERE m.company_id = c.company_id AND m.dismissed_at IS NULL) AS unread_messages
         FROM companies c
         LEFT JOIN company_subscriptions cs ON cs.company_id = c.company_id
         LEFT JOIN plans p ON p.plan_code = cs.plan_code
         LEFT JOIN license_grants g ON g.grant_id = cs.grant_id
         ORDER BY c.deleted_at NULLS FIRST, c.name`
      );
      return rows.map((r) => ({ ...r, selected_plan_code: null, last_notice: null }));
    } catch (err) {
      if (errCode(err) !== "42703" && errCode(err) !== "42P01") throw err;
    }

    // Tier 3 — pre-admin-controls base overview.
    const { rows } = await this.db.query(
      `SELECT
         c.company_id,
         c.name,
         c.owner_email,
         cs.plan_code,
         p.display_name AS plan_name,
         p.max_printers,
         cs.status,
         cs.source,
         cs.current_period_end,
         cs.limit_exceeded_since,
         g.code AS grant_code,
         (SELECT count(*)::int FROM printer_instances pi WHERE pi.company_id = c.company_id) AS printer_count
       FROM companies c
       LEFT JOIN company_subscriptions cs ON cs.company_id = c.company_id
       LEFT JOIN plans p ON p.plan_code = cs.plan_code
       LEFT JOIN license_grants g ON g.grant_id = cs.grant_id
       ORDER BY c.name`
    );
    return rows.map((r) => ({
      ...r,
      admin_hold: null,
      admin_hold_reason: null,
      deleted_at: null,
      unread_messages: 0,
      selected_plan_code: null,
      last_notice: null
    }));
  }

  // Manually put a company on a plan (Enterprise deals close here). Resets
  // the over-limit clock; a null/omitted end date means access until changed.
  @Post("assign")
  async assignPlan(@UserId() userId: string, @Body() body: unknown) {
    await this.assertPlatformAdmin(userId);
    const input = parseWithSchema(assignPlanSchema, body);

    const plan = await this.db.query(
      "SELECT 1 FROM plans WHERE plan_code = $1",
      [input.plan_code]
    );
    if (!plan.rowCount) throw new BadRequestException("Unknown plan code.");

    const company = await this.db.query(
      "SELECT 1 FROM companies WHERE company_id = $1",
      [input.company_id]
    );
    if (!company.rowCount) throw new NotFoundException("Company not found.");

    // A manual cancel takes effect immediately: anchor the grace window now.
    const status = input.status ?? "active";
    const periodEnd =
      status === "canceled" ? new Date().toISOString() : input.current_period_end ?? null;

    await this.db.query(
      `INSERT INTO company_subscriptions
         (company_id, plan_code, status, source, current_period_end, grant_id, limit_exceeded_since)
       VALUES ($1, $2, $3, 'manual', $4, NULL, NULL)
       ON CONFLICT (company_id) DO UPDATE SET
         plan_code = EXCLUDED.plan_code,
         status = EXCLUDED.status,
         source = 'manual',
         current_period_end = EXCLUDED.current_period_end,
         grant_id = NULL,
         limit_exceeded_since = NULL,
         updated_at = now()`,
      [input.company_id, input.plan_code, status, periodEnd]
    );

    this.licensing.invalidate(input.company_id);
    return this.licensing.getStatus(input.company_id, true);
  }

  // Stop a company's trial right now. Trials carry no grace (see
  // LicensingService.resolve), so expiring the trial this instant drops the
  // company straight into read-only — they must pick a plan or redeem a code
  // to keep working. Reversible: "assign" a plan (or the trial plan with a
  // future end date) to restore access.
  @Post("end-trial")
  async endTrial(@UserId() userId: string, @Body() body: unknown) {
    await this.assertPlatformAdmin(userId);
    const { company_id } = parseWithSchema(endTrialSchema, body);

    const { rows } = await this.db.query<{ status: string }>(
      "SELECT status FROM company_subscriptions WHERE company_id = $1",
      [company_id]
    );
    const sub = rows[0];
    if (!sub) throw new NotFoundException("This company has no trial to end.");
    if (sub.status !== "trialing") {
      throw new BadRequestException("This company is not on a trial.");
    }

    // Expire the trial a moment ago so the next resolve reads it as ended
    // regardless of app/DB clock skew. status stays 'trialing' and source
    // stays 'trial', so the tenant sees trial-flavoured "your trial has ended"
    // copy and the zero-grace rule applies.
    await this.db.query(
      `UPDATE company_subscriptions
       SET current_period_end = now() - INTERVAL '1 second',
           limit_exceeded_since = NULL,
           updated_at = now()
       WHERE company_id = $1`,
      [company_id]
    );

    this.licensing.invalidate(company_id);
    return this.licensing.getStatus(company_id, true);
  }

  // ── Bulk plan operations ─────────────────────────────────────────────────
  // Same semantics as their single-company counterparts, applied to an
  // explicit id list. Assign is all-or-nothing (one transaction); extend and
  // end-trial report per-company outcomes because rows can be legitimately
  // ineligible (no period end, not a trial) without failing the batch.

  @Post("bulk/assign")
  async bulkAssign(@UserId() userId: string, @Body() body: unknown) {
    await this.assertPlatformAdmin(userId);
    const input = parseWithSchema(bulkAssignSchema, body);

    const plan = await this.db.query("SELECT 1 FROM plans WHERE plan_code = $1", [input.plan_code]);
    if (!plan.rowCount) throw new BadRequestException("Unknown plan code.");

    const found = await this.db.query<{ company_id: string }>(
      "SELECT company_id FROM companies WHERE company_id = ANY($1::uuid[])",
      [input.company_ids]
    );
    if (found.rowCount !== input.company_ids.length) {
      throw new NotFoundException("Some of the selected companies no longer exist — refresh and retry.");
    }

    const status = input.status ?? "active";
    const periodEnd =
      status === "canceled" ? new Date().toISOString() : input.current_period_end ?? null;

    await this.db.transaction(async (client) => {
      for (const companyId of input.company_ids) {
        await this.db.query(
          `INSERT INTO company_subscriptions
             (company_id, plan_code, status, source, current_period_end, grant_id, limit_exceeded_since)
           VALUES ($1, $2, $3, 'manual', $4, NULL, NULL)
           ON CONFLICT (company_id) DO UPDATE SET
             plan_code = EXCLUDED.plan_code,
             status = EXCLUDED.status,
             source = 'manual',
             current_period_end = EXCLUDED.current_period_end,
             grant_id = NULL,
             limit_exceeded_since = NULL,
             updated_at = now()`,
          [companyId, input.plan_code, status, periodEnd],
          client
        );
      }
    });

    for (const companyId of input.company_ids) this.licensing.invalidate(companyId);
    return { ok: true, updated: input.company_ids.length };
  }

  // Push each selected company's period end out by N days (from its current
  // end, or from now if it already lapsed). Rows with no period end
  // (indefinite access) or a canceled/revoked status are skipped: indefinite
  // can't be extended, and a dead plan needs /assign, not more days.
  @Post("bulk/extend")
  async bulkExtend(@UserId() userId: string, @Body() body: unknown) {
    await this.assertPlatformAdmin(userId);
    const input = parseWithSchema(bulkExtendSchema, body);

    const res = await this.db.query<{ company_id: string; current_period_end: string }>(
      `UPDATE company_subscriptions
          SET current_period_end = GREATEST(current_period_end, now()) + make_interval(days => $2),
              updated_at = now()
        WHERE company_id = ANY($1::uuid[])
          AND current_period_end IS NOT NULL
          AND status IN ('trialing', 'active')
        RETURNING company_id, current_period_end`,
      [input.company_ids, input.days]
    );

    const updated = res.rows.map((r) => r.company_id);
    const updatedSet = new Set(updated);
    for (const companyId of updated) this.licensing.invalidate(companyId);

    return {
      ok: true,
      updated,
      skipped: input.company_ids.filter((id) => !updatedSet.has(id))
    };
  }

  // End every selected company's still-running trial (straight to read-only —
  // trials carry no grace). Non-trials and already-ended trials are skipped.
  @Post("bulk/end-trial")
  async bulkEndTrial(@UserId() userId: string, @Body() body: unknown) {
    await this.assertPlatformAdmin(userId);
    const input = parseWithSchema(bulkEndTrialSchema, body);

    const res = await this.db.query<{ company_id: string }>(
      `UPDATE company_subscriptions
          SET current_period_end = now() - INTERVAL '1 second',
              limit_exceeded_since = NULL,
              updated_at = now()
        WHERE company_id = ANY($1::uuid[])
          AND status = 'trialing'
          AND (current_period_end IS NULL OR current_period_end > now())
        RETURNING company_id`,
      [input.company_ids]
    );

    const updated = res.rows.map((r) => r.company_id);
    const updatedSet = new Set(updated);
    for (const companyId of updated) this.licensing.invalidate(companyId);

    return {
      ok: true,
      updated,
      skipped: input.company_ids.filter((id) => !updatedSet.has(id))
    };
  }

  // ── Moderation holds ─────────────────────────────────────────────────────
  // Set or lift a hold. grace → nag + block printer adds; suspended → workspace
  // read-only; banned → full lockout. hold=null lifts it. Enforced immediately
  // in the LicenseGuard (not gated by LICENSING_ENFORCED).
  @Post("hold")
  async setHold(@UserId() userId: string, @Body() body: unknown) {
    const adminEmail = await this.assertPlatformAdmin(userId);
    const input = parseWithSchema(setHoldSchema, body);

    const res = await this.db.query(
      `UPDATE companies
         SET admin_hold = $2,
             admin_hold_reason = CASE WHEN $2::text IS NULL THEN NULL ELSE $3 END,
             admin_hold_at     = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END,
             admin_hold_by     = CASE WHEN $2::text IS NULL THEN NULL ELSE $4 END
       WHERE company_id = $1`,
      [input.company_id, input.hold, input.reason ?? null, adminEmail]
    );
    if (!res.rowCount) throw new NotFoundException("Company not found.");

    this.licensing.invalidate(input.company_id);
    return this.licensing.getStatus(input.company_id, true);
  }

  // Bulk: set or lift (hold=null) the same moderation hold on many companies.
  @Post("bulk/hold")
  async bulkHold(@UserId() userId: string, @Body() body: unknown) {
    const adminEmail = await this.assertPlatformAdmin(userId);
    const input = parseWithSchema(bulkHoldSchema, body);

    const res = await this.db.query<{ company_id: string }>(
      `UPDATE companies
         SET admin_hold = $2,
             admin_hold_reason = CASE WHEN $2::text IS NULL THEN NULL ELSE $3 END,
             admin_hold_at     = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END,
             admin_hold_by     = CASE WHEN $2::text IS NULL THEN NULL ELSE $4 END
       WHERE company_id = ANY($1::uuid[])
       RETURNING company_id`,
      [input.company_ids, input.hold, input.reason ?? null, adminEmail]
    );
    if (!res.rowCount) throw new NotFoundException("None of the selected companies exist.");

    for (const row of res.rows) this.licensing.invalidate(row.company_id);
    return { ok: true, updated: res.rowCount };
  }

  // Soft-delete: full lockout + hidden by default, all data retained. Reversible
  // via /restore. current_period_end is left untouched so restore returns the
  // company to exactly its prior billing state.
  @Post("delete")
  async softDelete(@UserId() userId: string, @Body() body: unknown) {
    const adminEmail = await this.assertPlatformAdmin(userId);
    const input = parseWithSchema(companyRefSchema, body);

    const res = await this.db.query(
      `UPDATE companies
         SET deleted_at = COALESCE(deleted_at, now()),
             deleted_by = $2,
             admin_hold_reason = COALESCE($3, admin_hold_reason)
       WHERE company_id = $1`,
      [input.company_id, adminEmail, input.reason ?? null]
    );
    if (!res.rowCount) throw new NotFoundException("Company not found.");

    this.licensing.invalidate(input.company_id);
    return { ok: true };
  }

  // Restore a soft-deleted company.
  @Post("restore")
  async restore(@UserId() userId: string, @Body() body: unknown) {
    await this.assertPlatformAdmin(userId);
    const input = parseWithSchema(companyRefSchema, body);

    const res = await this.db.query(
      "UPDATE companies SET deleted_at = NULL, deleted_by = NULL WHERE company_id = $1",
      [input.company_id]
    );
    if (!res.rowCount) throw new NotFoundException("Company not found.");

    this.licensing.invalidate(input.company_id);
    return this.licensing.getStatus(input.company_id, true);
  }

  // ── In-app messages ──────────────────────────────────────────────────────
  // Send a message to a company; the tenant sees a dismissible in-app banner.
  @Post("messages")
  async sendMessage(@UserId() userId: string, @Body() body: unknown) {
    const adminEmail = await this.assertPlatformAdmin(userId);
    const input = parseWithSchema(sendMessageSchema, body);

    const company = await this.db.query(
      "SELECT 1 FROM companies WHERE company_id = $1",
      [input.company_id]
    );
    if (!company.rowCount) throw new NotFoundException("Company not found.");

    const { rows } = await this.db.query(
      `INSERT INTO company_admin_messages (company_id, body, created_by)
       VALUES ($1, $2, $3)
       RETURNING message_id, company_id, body, created_by, created_at, dismissed_at`,
      [input.company_id, input.body, adminEmail]
    );
    return rows[0];
  }

  // Message history for one company (context for the admin composer).
  @Get("messages/:companyId")
  async listCompanyMessages(@UserId() userId: string, @Param("companyId") companyId: string) {
    await this.assertPlatformAdmin(userId);
    const { rows } = await this.db.query(
      `SELECT message_id, body, created_by, created_at, dismissed_at
       FROM company_admin_messages
       WHERE company_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [companyId]
    );
    return rows;
  }

  // Bulk: the same in-app message to many companies at once.
  @Post("bulk/messages")
  async bulkMessage(@UserId() userId: string, @Body() body: unknown) {
    const adminEmail = await this.assertPlatformAdmin(userId);
    const input = parseWithSchema(bulkMessageSchema, body);

    const found = await this.db.query<{ company_id: string }>(
      "SELECT company_id FROM companies WHERE company_id = ANY($1::uuid[])",
      [input.company_ids]
    );
    if (!found.rowCount) throw new NotFoundException("None of the selected companies exist.");

    const res = await this.db.query(
      `INSERT INTO company_admin_messages (company_id, body, created_by)
       SELECT unnest($1::uuid[]), $2, $3
       RETURNING message_id`,
      [found.rows.map((r) => r.company_id), input.body, adminEmail]
    );
    return { ok: true, sent: res.rowCount ?? 0 };
  }

  // ── Owner emails ─────────────────────────────────────────────────────────
  // Compose + send a real email to the owner of each selected company (single
  // or bulk). {{company}} {{plan}} {{owner_email}} {{period_end}} {{days_left}}
  // are substituted per company. Delivery rides the same EMAIL_ENABLED gate as
  // every other email (dry_run when off); every attempt is recorded in
  // license_emails (type admin_custom) so the compose history is auditable.
  @Post("email")
  async sendOwnerEmail(@UserId() userId: string, @Body() body: unknown) {
    const adminEmail = await this.assertPlatformAdmin(userId);
    const input = parseWithSchema(adminEmailSchema, body);

    const { rows: targets } = await this.db.query<{
      company_id: string;
      name: string;
      owner_email: string | null;
      plan_name: string | null;
      current_period_end: string | Date | null;
    }>(
      `SELECT c.company_id, c.name, c.owner_email,
              p.display_name AS plan_name, cs.current_period_end
         FROM companies c
         LEFT JOIN company_subscriptions cs ON cs.company_id = c.company_id
         LEFT JOIN plans p ON p.plan_code = cs.plan_code
        WHERE c.company_id = ANY($1::uuid[])`,
      [input.company_ids]
    );
    if (targets.length === 0) throw new NotFoundException("None of the selected companies exist.");

    const appUrl = this.appUrl();
    let sent = 0;
    let dryRun = 0;
    const skipped: { company_id: string; company: string; reason: string }[] = [];

    for (const target of targets) {
      const recipient = (target.owner_email ?? "").trim();
      if (!recipient) {
        skipped.push({ company_id: target.company_id, company: target.name, reason: "no owner email on file" });
        await this.recordAdminEmail(target.company_id, adminEmail, null, input.subject, null, "skipped", "no owner email on file");
        continue;
      }

      const vars = this.emailVars(target.name, target.plan_name, target.current_period_end, recipient);
      const subject = substituteVars(input.subject, vars);
      const bodyText = substituteVars(input.body, vars);
      const message = composePlatformEmail({ subject, body: bodyText, companyName: target.name, appUrl });

      try {
        const result = await this.email.send({
          to: recipient,
          subject: message.subject,
          text: message.text,
          html: message.html
        });
        if (result === "sent") sent += 1;
        else dryRun += 1;
        await this.recordAdminEmail(target.company_id, adminEmail, recipient, message.subject, message.text, result, null);
      } catch (e) {
        // Custom sends have no retry sweep — record the failure for the audit
        // trail and surface it in the response instead.
        const reason = `delivery failed: ${(e as Error).message}`;
        skipped.push({ company_id: target.company_id, company: target.name, reason });
        await this.recordAdminEmail(target.company_id, adminEmail, recipient, message.subject, null, "skipped", reason);
      }
    }

    return { ok: true, sent, dry_run: dryRun, skipped };
  }

  // Full notice + custom-email history for one company, newest first (the
  // admin drawer's "Emails" panel). Empty pre-migration rather than erroring.
  @Get("emails/:companyId")
  async listCompanyEmails(@UserId() userId: string, @Param("companyId") companyId: string) {
    await this.assertPlatformAdmin(userId);
    try {
      const { rows } = await this.db.query(
        `SELECT license_email_id, email_type, period_anchor, recipient_email,
                subject, body, status, error, created_by, created_at
           FROM license_emails
          WHERE company_id = $1
          ORDER BY created_at DESC
          LIMIT 100`,
        [companyId]
      );
      return rows;
    } catch (err) {
      if ((err as { code?: string }).code === "42P01") return [];
      throw err;
    }
  }

  @Get("grants")
  async listGrants(@UserId() userId: string) {
    await this.assertPlatformAdmin(userId);
    const { rows } = await this.db.query(
      `SELECT
         g.grant_id, g.code, g.plan_code, p.display_name AS plan_name,
         g.note, g.created_by, g.created_at, g.expires_at, g.revoked_at,
         g.redeemed_by_company_id, g.redeemed_at,
         c.name AS redeemed_by_company_name
       FROM license_grants g
       JOIN plans p ON p.plan_code = g.plan_code
       LEFT JOIN companies c ON c.company_id = g.redeemed_by_company_id
       ORDER BY g.created_at DESC`
    );
    return rows;
  }

  // Mint grant code(s) for a plan — one by default, up to 50 in a batch
  // (count). The retry loop absorbs the (vanishingly rare) random-code
  // collision against the UNIQUE constraint. The response keeps the original
  // single-code shape (spread of the first row) and adds `codes` with the
  // full batch, so older clients keep working.
  @Post("grants")
  async createGrant(@UserId() userId: string, @Body() body: unknown) {
    const adminEmail = await this.assertPlatformAdmin(userId);
    const input = parseWithSchema(createGrantSchema, body);
    const count = input.count ?? 1;

    const plan = await this.db.query(
      "SELECT 1 FROM plans WHERE plan_code = $1",
      [input.plan_code]
    );
    if (!plan.rowCount) throw new BadRequestException("Unknown plan code.");

    const created: Record<string, unknown>[] = [];
    for (let i = 0; i < count; i++) {
      let inserted = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = this.licensing.generateGrantCode();
        try {
          const { rows } = await this.db.query(
            `INSERT INTO license_grants (code, plan_code, note, created_by, expires_at)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING grant_id, code, plan_code, note, created_by, created_at, expires_at`,
            [code, input.plan_code, input.note ?? null, adminEmail, input.expires_at ?? null]
          );
          created.push(rows[0] as Record<string, unknown>);
          inserted = true;
          break;
        } catch (err) {
          const uniqueViolation =
            typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
          if (!uniqueViolation || attempt === 4) throw err;
        }
      }
      if (!inserted) throw new BadRequestException("Could not generate a unique grant code.");
    }

    return { ...created[0]!, codes: created };
  }

  // Revoke a code. If a company is living on it, their subscription flips to
  // 'revoked' with the grace window anchored now — the standard
  // grace → read-only path, exactly as promised ("free until we revoke").
  @Post("grants/:grantId/revoke")
  async revokeGrant(@UserId() userId: string, @Param("grantId") grantId: string) {
    await this.assertPlatformAdmin(userId);

    let affectedCompany: string | null = null;
    await this.db.transaction(async (client) => {
      const { rows } = await this.db.query<{
        grant_id: string;
        revoked_at: string | Date | null;
        redeemed_by_company_id: string | null;
      }>(
        "SELECT grant_id, revoked_at, redeemed_by_company_id FROM license_grants WHERE grant_id = $1 FOR UPDATE",
        [grantId],
        client
      );
      const grant = rows[0];
      if (!grant) throw new NotFoundException("Grant code not found.");
      if (grant.revoked_at !== null) return; // already revoked — idempotent

      await this.db.query(
        "UPDATE license_grants SET revoked_at = now() WHERE grant_id = $1",
        [grantId],
        client
      );

      if (grant.redeemed_by_company_id) {
        await this.db.query(
          `UPDATE company_subscriptions
           SET status = 'revoked', current_period_end = now(), updated_at = now()
           WHERE company_id = $1 AND source = 'grant_code' AND grant_id = $2`,
          [grant.redeemed_by_company_id, grantId],
          client
        );
        affectedCompany = grant.redeemed_by_company_id;
      }
    });

    if (affectedCompany) this.licensing.invalidate(affectedCompany);
    return { ok: true };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Per-company {{variable}} values for admin-composed emails. */
  private emailVars(
    companyName: string,
    planName: string | null,
    periodEnd: string | Date | null,
    ownerEmail: string
  ): Record<string, string> {
    let periodEndText = "—";
    let daysLeftText = "—";
    if (periodEnd) {
      const end = new Date(periodEnd);
      if (!Number.isNaN(end.getTime())) {
        periodEndText = end.toLocaleDateString("en-US", {
          year: "numeric",
          month: "long",
          day: "numeric"
        });
        daysLeftText = String(Math.max(0, Math.ceil((end.getTime() - Date.now()) / 86_400_000)));
      }
    }
    return {
      company: companyName,
      plan: planName ?? "—",
      owner_email: ownerEmail,
      period_end: periodEndText,
      days_left: daysLeftText
    };
  }

  /**
   * Ledger row for an admin-composed email. period_anchor is the send moment
   * (admin sends are unlimited — the unique index never bites). Best-effort:
   * a missing license_emails table (pre-migration) must not fail the send.
   */
  private async recordAdminEmail(
    companyId: string,
    adminEmail: string,
    recipient: string | null,
    subject: string | null,
    body: string | null,
    status: "sent" | "dry_run" | "skipped",
    error: string | null
  ): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO license_emails
           (company_id, email_type, period_anchor, recipient_email, subject, body, status, error, created_by)
         VALUES ($1, 'admin_custom', $2, $3, $4, $5, $6, $7, $8)`,
        [companyId, new Date().toISOString(), recipient, subject, body, status, error, adminEmail]
      );
    } catch {
      // license_emails not migrated yet — the send still happened; only the
      // audit row is lost.
    }
  }

  /** Public app origin for links in owner emails (same as the notice sweep). */
  private appUrl(): string {
    return (process.env.PUBLIC_APP_URL || process.env.ALLOWED_ORIGIN || "https://printexec-client.pages.dev")
      .split(",")[0]!
      .trim()
      .replace(/\/+$/, "");
  }

  // Allowlist check; returns the admin's email for audit columns.
  private async assertPlatformAdmin(userId: string): Promise<string> {
    const { rows } = await this.db.query<{ email: string }>(
      "SELECT email FROM users WHERE id = $1",
      [userId]
    );
    const email = rows[0]?.email;
    if (!this.licensing.isPlatformAdminEmail(email)) {
      throw new ForbiddenException("Not allowed.");
    }
    return email!;
  }
}
