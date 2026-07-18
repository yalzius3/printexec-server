import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  GoneException,
  Headers,
  NotFoundException,
  Param,
  Post
} from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { CompanyId } from "../common/company-id.decorator";
import { UserRole } from "../common/user-role.decorator";
import { parseWithSchema } from "../common/zod";
import { DatabaseService } from "../database/database.service";
import { LicenseExempt } from "./license-exempt.decorator";
import { checkoutSchema, redeemGrantSchema } from "./licensing.schemas";
import { LicensingService, type LicenseStatus } from "./licensing.service";
import { PaymentsService, type CheckoutResult } from "./payments.service";
import { TERMS_VERSION } from "./terms";

interface PlanRow {
  plan_code: string;
  display_name: string;
  max_printers: number | null;
  is_public: boolean;
  sort_order: number;
  // Pricing-catalogue columns (2026-07-17 migration; absent pre-migration).
  // NUMERIC arrives from pg as a string.
  price_monthly_usd?: string | null;
  blurb?: string | null;
  features?: string[] | null;
  self_serve?: boolean;
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
    private readonly db: DatabaseService,
    private readonly payments: PaymentsService
  ) {}

  // Plan catalogue with the pricing columns; falls back to the pre-2026-07-17
  // shape so a not-yet-migrated DB still returns the tiers.
  private async loadPlans(publicOnly: boolean): Promise<PlanRow[]> {
    const where = publicOnly ? "WHERE is_public" : "";
    try {
      const { rows } = await this.db.query<PlanRow>(
        `SELECT plan_code, display_name, max_printers, is_public, sort_order,
                price_monthly_usd, blurb, features, self_serve
         FROM plans ${where} ORDER BY sort_order`
      );
      return rows;
    } catch {
      const { rows } = await this.db.query<PlanRow>(
        `SELECT plan_code, display_name, max_printers, is_public, sort_order
         FROM plans ${where} ORDER BY sort_order`
      );
      return rows;
    }
  }

  // Public pricing catalogue + current terms version. @Public: this is what
  // the signup flow renders BEFORE any company exists (and the marketing
  // site may reuse it) — it exposes nothing tenant-specific.
  @Public()
  @Get("plans")
  async listPlans(): Promise<{ terms_version: string; trial_days: number; plans: PlanRow[] }> {
    let plans: PlanRow[] = [];
    try {
      plans = await this.loadPlans(true);
    } catch {
      // plans table not migrated yet — the client falls back to its built-in
      // catalogue, so an empty list must not 500.
    }
    return { terms_version: TERMS_VERSION, trial_days: this.licensing.trialDays, plans };
  }

  // Current license state + the plan catalogue (for the plan screen). The
  // catalogue read is best-effort so a not-yet-migrated DB never 500s here.
  @Get("status")
  async getStatus(
    @CompanyId() companyId: string
  ): Promise<LicenseStatus & { plans: PlanRow[]; selected_plan_code: string | null }> {
    const status = await this.licensing.getStatus(companyId);
    let plans: PlanRow[] = [];
    try {
      plans = await this.loadPlans(false);
    } catch {
      // plans table not migrated yet — status alone is still useful
    }
    // Checkout intent recorded while payments are offline (best-effort).
    let selectedPlanCode: string | null = null;
    try {
      const { rows } = await this.db.query<{ selected_plan_code: string | null }>(
        "SELECT selected_plan_code FROM company_subscriptions WHERE company_id = $1",
        [companyId]
      );
      selectedPlanCode = rows[0]?.selected_plan_code ?? null;
    } catch {
      // column not migrated yet
    }
    return { ...status, plans, selected_plan_code: selectedPlanCode };
  }

  // Owner-only: buy a self-serve plan. While no payment provider is live this
  // records the choice (selected_plan_code) and returns available:false with
  // friendly copy; once a provider is configured it returns the hosted
  // checkout URL instead. @LicenseExempt (class): a lapsed workspace must be
  // able to buy its way out.
  @Post("checkout")
  async checkout(
    @CompanyId() companyId: string,
    @UserRole() role: "owner" | "staff",
    @Body() body: unknown
  ): Promise<CheckoutResult & { selected_plan_code: string }> {
    if (role !== "owner") {
      throw new ForbiddenException("Only the company owner can change the plan.");
    }
    const { plan_code } = parseWithSchema(checkoutSchema, body);

    // Must be a real, publicly listed, self-serve tier. Pre-migration (no
    // self_serve column) the known self-serve pair is allowed through.
    let purchasable = false;
    try {
      const { rows } = await this.db.query<{ self_serve?: boolean }>(
        "SELECT self_serve FROM plans WHERE plan_code = $1 AND is_public",
        [plan_code]
      );
      purchasable = rows.length > 0 && rows[0]!.self_serve !== false;
    } catch {
      purchasable = plan_code === "starter" || plan_code === "growth";
    }
    if (!purchasable) {
      throw new BadRequestException(
        "That plan isn't available for online checkout — contact us and we'll set it up."
      );
    }

    // Record the intent on the subscription row (created lazily if the
    // company predates licensing). Best-effort: pre-migration schemas must
    // not block the (informative) checkout response.
    try {
      await this.licensing.ensureTrial(companyId);
      await this.db.query(
        "UPDATE company_subscriptions SET selected_plan_code = $2, updated_at = now() WHERE company_id = $1",
        [companyId, plan_code]
      );
      this.licensing.invalidate(companyId);
    } catch {
      // selected_plan_code not migrated yet — the choice just isn't persisted
    }

    const result = await this.payments.createCheckout(companyId, plan_code);
    return { ...result, selected_plan_code: plan_code };
  }

  // Async payment-provider notifications. @Public — providers authenticate
  // via signed payloads, not user tokens; verification lives in the provider
  // implementation (over the RAW body — see PaymentsService notes). With no
  // provider configured this is a 404.
  @Public()
  @Post("payments/webhook/:provider")
  async paymentWebhook(
    @Param("provider") provider: string,
    @Body() body: unknown,
    @Headers() headers: Record<string, string | string[] | undefined>
  ): Promise<{ ok: boolean }> {
    return this.payments.handleWebhook(provider, body, headers);
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
