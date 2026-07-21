import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  SetMetadata,
  UnauthorizedException
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AuthRequest } from "../auth/supabase.guard";
import { DatabaseService } from "../database/database.service";
import { AdminSessionService } from "./admin-session.service";
import { LicensingService } from "./licensing.service";

/** Marks the unlock route itself, which obviously can't require a session. */
export const SKIP_ADMIN_SESSION_KEY = "skipAdminSession";
export const SkipAdminSession = () => SetMetadata(SKIP_ADMIN_SESSION_KEY, true);

/** Header carrying the short-lived admin session token. */
export const ADMIN_SESSION_HEADER = "x-admin-session";

/** Request shape after this guard runs. */
export interface AdminRequest extends AuthRequest {
  adminEmail: string;
}

/**
 * Two-factor gate for the whole platform-admin controller. Runs after the
 * global SupabaseAuthGuard, so req.userId is already trustworthy.
 *
 *   1. the authenticated account's email must be on PLATFORM_ADMIN_EMAILS
 *   2. the request must carry a valid, unexpired x-admin-session token that
 *      was minted for THIS user by entering PLATFORM_ADMIN_SECRET
 *
 * Failing (1) is 403 "Not allowed" — deliberately identical to what a
 * non-admin sees anywhere else, so the admin surface isn't discoverable by
 * probing. Failing (2) is 401 with code "admin_session_required", which is the
 * client's cue to show the passphrase prompt.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  private readonly logger = new Logger(PlatformAdminGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly db: DatabaseService,
    private readonly licensing: LicensingService,
    private readonly sessions: AdminSessionService
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AdminRequest>();
    const userId = req.userId;
    if (!userId) throw new ForbiddenException("Not allowed.");

    // ── Factor 1: the email allowlist ──
    const { rows } = await this.db.query<{ email: string }>(
      "SELECT email FROM users WHERE id = $1",
      [userId]
    );
    const email = rows[0]?.email;
    if (!this.licensing.isPlatformAdminEmail(email)) {
      this.logger.warn(`Rejected platform-admin request from non-admin user ${userId}.`);
      throw new ForbiddenException("Not allowed.");
    }
    req.adminEmail = email!;

    // The unlock route needs factor 1 only — factor 2 is what it issues.
    const skipSession = this.reflector.getAllAndOverride<boolean>(SKIP_ADMIN_SESSION_KEY, [
      ctx.getHandler(),
      ctx.getClass()
    ]);
    if (skipSession) return true;

    // ── Factor 2: an unlocked admin session ──
    const raw = req.headers?.[ADMIN_SESSION_HEADER];
    const token = Array.isArray(raw) ? raw[0] : raw;
    if (!this.sessions.verify(token, userId)) {
      throw new UnauthorizedException({
        statusCode: 401,
        code: "admin_session_required",
        message: this.sessions.enabled
          ? "Unlock the admin area to continue."
          : "The admin area is not configured on this deployment."
      });
    }

    return true;
  }
}
