import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  GoneException,
  NotFoundException,
  Param,
  Post
} from "@nestjs/common";
import { CompanyId } from "../common/company-id.decorator";
import { UserRole } from "../common/user-role.decorator";
import { parseWithSchema } from "../common/zod";
import { DatabaseService } from "../database/database.service";
import { LicenseExempt } from "./license-exempt.decorator";
import { redeemGrantSchema } from "./licensing.schemas";
import { LicensingService, type LicenseStatus } from "./licensing.service";

interface PlanRow {
  plan_code: string;
  display_name: string;
  max_printers: number | null;
  is_public: boolean;
  sort_order: number;
}

interface GrantRow {
  grant_id: string;
  plan_code: string;
  expires_at: string | Date | null;
  revoked_at: string | Date | null;
  redeemed_by_company_id: string | null;
}

// Tenant-facing licensing endpoints. @LicenseExempt: a company that has gone
// read-only must still be able to see its status and redeem a grant code —
// these routes ARE the way out of the locked state.
@LicenseExempt()
@Controller("licensing")
export class LicensingController {
  constructor(
    private readonly licensing: LicensingService,
    private readonly db: DatabaseService
  ) {}

  // Current license state + the plan catalogue (for the plan screen). The
  // catalogue read is best-effort so a not-yet-migrated DB never 500s here.
  @Get("status")
  async getStatus(@CompanyId() companyId: string): Promise<LicenseStatus & { plans: PlanRow[] }> {
    const status = await this.licensing.getStatus(companyId);
    let plans: PlanRow[] = [];
    try {
      const { rows } = await this.db.query<PlanRow>(
        "SELECT plan_code, display_name, max_printers, is_public, sort_order FROM plans ORDER BY sort_order"
      );
      plans = rows;
    } catch {
      // plans table not migrated yet — status alone is still useful
    }
    return { ...status, plans };
  }

  // Owner-only: redeem a platform-issued grant code. Single-use; the company
  // holds the granted plan until the code is revoked (or its hard end date).
  @Post("redeem")
  async redeem(
    @CompanyId() companyId: string,
    @UserRole() role: "owner" | "staff",
    @Body() body: unknown
  ) {
    if (role !== "owner") {
      throw new ForbiddenException("Only the company owner can redeem a grant code.");
    }
    const { code } = parseWithSchema(redeemGrantSchema, body);

    await this.db.transaction(async (client) => {
      const { rows } = await this.db.query<GrantRow>(
        `SELECT grant_id, plan_code, expires_at, revoked_at, redeemed_by_company_id
         FROM license_grants
         WHERE upper(code) = upper($1)
         FOR UPDATE`,
        [code],
        client
      );
      const grant = rows[0];
      if (!grant) {
        throw new NotFoundException("This grant code doesn't exist. Check the code and try again.");
      }
      if (grant.revoked_at !== null) {
        throw new GoneException("This grant code has been revoked.");
      }
      if (grant.expires_at !== null && new Date(grant.expires_at).getTime() < Date.now()) {
        throw new GoneException("This grant code has expired.");
      }
      if (grant.redeemed_by_company_id !== null && grant.redeemed_by_company_id !== companyId) {
        throw new ConflictException("This grant code has already been used by another company.");
      }

      // Re-redeeming your own code just re-applies it — harmless and lets a
      // tenant recover if the first attempt half-failed.
      await this.db.query(
        `INSERT INTO company_subscriptions
           (company_id, plan_code, status, source, current_period_end, grant_id, limit_exceeded_since)
         VALUES ($1, $2, 'active', 'grant_code', $3, $4, NULL)
         ON CONFLICT (company_id) DO UPDATE SET
           plan_code = EXCLUDED.plan_code,
           status = 'active',
           source = 'grant_code',
           current_period_end = EXCLUDED.current_period_end,
           grant_id = EXCLUDED.grant_id,
           limit_exceeded_since = NULL,
           updated_at = now()`,
        [companyId, grant.plan_code, grant.expires_at, grant.grant_id],
        client
      );

      await this.db.query(
        `UPDATE license_grants
         SET redeemed_by_company_id = $1, redeemed_at = COALESCE(redeemed_at, now())
         WHERE grant_id = $2`,
        [companyId, grant.grant_id],
        client
      );
    });

    this.licensing.invalidate(companyId);
    return this.licensing.getStatus(companyId, true);
  }

  // In-app messages the platform sent this company. @LicenseExempt (class-level)
  // so a suspended / read-only workspace can still read and dismiss them.
  @Get("messages")
  async listMessages(@CompanyId() companyId: string) {
    try {
      const { rows } = await this.db.query(
        `SELECT message_id, body, created_at
         FROM company_admin_messages
         WHERE company_id = $1 AND dismissed_at IS NULL
         ORDER BY created_at DESC`,
        [companyId]
      );
      return rows;
    } catch {
      // messages table not migrated yet — nothing to show.
      return [];
    }
  }

  @Post("messages/:messageId/dismiss")
  async dismissMessage(
    @CompanyId() companyId: string,
    @Param("messageId") messageId: string
  ) {
    await this.db.query(
      `UPDATE company_admin_messages SET dismissed_at = now()
       WHERE message_id = $1 AND company_id = $2 AND dismissed_at IS NULL`,
      [messageId, companyId]
    );
    return { ok: true };
  }
}
