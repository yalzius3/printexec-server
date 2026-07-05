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
import { LicenseExempt } from "./license-exempt.decorator";
import { assignPlanSchema, createGrantSchema } from "./licensing.schemas";
import { LicensingService } from "./licensing.service";

// ════════════════════════════════════════════════════════════════
// Platform-owner licensing admin. NOT tenant-scoped: these endpoints see and
// modify every company's plan, so access is limited to the email allowlist
// in PLATFORM_ADMIN_EMAILS (asserted per-request against the authenticated
// user — there is no platform-admin role in the tenant model).
// @LicenseExempt so an admin is never blocked by their own company's state.
// ════════════════════════════════════════════════════════════════

@LicenseExempt()
@Controller("licensing/admin")
export class LicensingAdminController {
  constructor(
    private readonly licensing: LicensingService,
    private readonly db: DatabaseService
  ) {}

  // Every company with its plan, state anchors, printer count, and any grant
  // code backing its access.
  @Get("overview")
  async overview(@UserId() userId: string) {
    await this.assertPlatformAdmin(userId);
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
    return rows;
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

  // Mint a grant code for a plan. The retry loop absorbs the (vanishingly
  // rare) random-code collision against the UNIQUE constraint.
  @Post("grants")
  async createGrant(@UserId() userId: string, @Body() body: unknown) {
    const adminEmail = await this.assertPlatformAdmin(userId);
    const input = parseWithSchema(createGrantSchema, body);

    const plan = await this.db.query(
      "SELECT 1 FROM plans WHERE plan_code = $1",
      [input.plan_code]
    );
    if (!plan.rowCount) throw new BadRequestException("Unknown plan code.");

    for (let attempt = 0; attempt < 5; attempt++) {
      const code = this.licensing.generateGrantCode();
      try {
        const { rows } = await this.db.query(
          `INSERT INTO license_grants (code, plan_code, note, created_by, expires_at)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING grant_id, code, plan_code, note, created_by, created_at, expires_at`,
          [code, input.plan_code, input.note ?? null, adminEmail, input.expires_at ?? null]
        );
        return rows[0];
      } catch (err) {
        const uniqueViolation =
          typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
        if (!uniqueViolation || attempt === 4) throw err;
      }
    }
    throw new BadRequestException("Could not generate a unique grant code.");
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
