import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";
import { PUBLIC_KEY, type AuthRequest } from "../auth/supabase.guard";
import { LICENSE_EXEMPT_KEY } from "./license-exempt.decorator";
import { LicensingService } from "./licensing.service";

/**
 * Runs after SupabaseAuthGuard + PermissionGuard. Enforces the licensing
 * end-state: once a company's grace window has lapsed (state "readonly"),
 * every mutating request is rejected with 403 while reads keep working —
 * the tenant can still see all their data, they just can't change it until
 * the plan is fixed.
 *
 * Never triggers on: @Public routes, @LicenseExempt routes (licensing
 * endpoints, upload-session cookie, platform-admin area), or read methods.
 * The finer-grained "grace" rule (printer adds blocked) lives next to the
 * printer-create transaction in LicensingService.assertCanAddPrinter, not
 * here. Dry-run (LICENSING_ENFORCED unset) logs instead of blocking.
 */
@Injectable()
export class LicenseGuard implements CanActivate {
  private readonly logger = new Logger(LicenseGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly licensing: LicensingService
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;
    if (this.reflector.getAllAndOverride<boolean>(LICENSE_EXEMPT_KEY, targets)) return true;

    const req = ctx.switchToHttp().getRequest<AuthRequest & FastifyRequest>();
    // No company on the request (public/pre-setup flows) → nothing to gate.
    if (!req.companyId) return true;

    const status = await this.licensing.getStatus(req.companyId);

    // ── Hard admin lockout: a banned or soft-deleted company is cut off
    // entirely — reads included — and immediately, regardless of
    // LICENSING_ENFORCED. This is an explicit platform decision, not the
    // dry-run billing gate. @Public + @LicenseExempt routes were already let
    // through above, so the tenant can still hit /auth/me and /licensing to
    // learn why they are locked out. ──
    if (status.deleted || status.admin_hold === "banned") {
      throw new ForbiddenException(
        status.deleted
          ? "This workspace has been removed. Contact support if you believe this is a mistake."
          : "This workspace has been banned. Contact support if you believe this is a mistake."
      );
    }

    const method = (req.method ?? "GET").toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;

    if (status.state !== "readonly") return true;

    // Admin-imposed read-only (suspend) is enforced immediately; the automated
    // billing gate stays behind LICENSING_ENFORCED (dry-run).
    const adminImposed = status.admin_hold === "suspended";
    if (!this.licensing.enforced && !adminImposed) {
      this.logger.log(
        `[dry-run] Would block ${method} ${req.url} for company ${req.companyId} (license readonly: ${status.reason})`
      );
      return true;
    }

    throw new ForbiddenException(
      adminImposed
        ? "Your workspace has been suspended by an administrator. Contact support to restore access."
        : status.status === "trialing"
          ? "Your trial has ended — your workspace is read-only. Choose a plan to continue."
          : "Your plan is inactive and the grace period is over — your workspace is read-only. Renew your plan to continue."
    );
  }
}
