import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AuthRequest } from "./supabase.guard";
import { UPLOAD_COOKIE_NAME, readCookie, verifyUploadCookie } from "./upload-cookie";

/**
 * Authorizes the guarded uploads serve route via the signed HttpOnly cookie set
 * by POST /api/auth/session. Used in place of SupabaseAuthGuard for that route
 * only, because the browser cannot attach a Bearer header to <img>/<iframe>/<a>
 * /STL-viewer fetches. On success it sets req.companyId so the controller can
 * verify the requested path's company segment matches the caller's company.
 */
@Injectable()
export class UploadCookieGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx
      .switchToHttp()
      .getRequest<AuthRequest & { headers: Record<string, string | string[] | undefined> }>();

    const raw = req.headers["cookie"];
    const cookieHeader = Array.isArray(raw) ? raw.join("; ") : raw;
    const token = readCookie(cookieHeader, UPLOAD_COOKIE_NAME);
    if (!token) {
      throw new UnauthorizedException("Missing upload session.");
    }

    const companyId = verifyUploadCookie(
      this.config.getOrThrow<string>("SUPABASE_SERVICE_ROLE_KEY"),
      token
    );
    if (!companyId) {
      throw new UnauthorizedException("Invalid or expired upload session.");
    }

    req.companyId = companyId;
    return true;
  }
}
