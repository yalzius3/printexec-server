import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { DatabaseService } from "../database/database.service";
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
  private readonly supabase: SupabaseClient;

  constructor(
    private readonly config: ConfigService,
    private readonly db: DatabaseService
  ) {
    this.supabase = createClient(
      this.config.getOrThrow("SUPABASE_URL"),
      this.config.getOrThrow("SUPABASE_SERVICE_ROLE_KEY")
    );
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx
      .switchToHttp()
      .getRequest<AuthRequest & { headers: Record<string, string | string[] | undefined> }>();

    const authRaw = req.headers["authorization"];
    const authHeader = Array.isArray(authRaw) ? authRaw[0] : authRaw;
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      const { data, error } = await this.supabase.auth.getUser(token);
      if (!error && data.user) {
        const { rows } = await this.db.query<{ company_id: string }>(
          "SELECT company_id FROM users WHERE id = $1",
          [data.user.id]
        );
        if (rows.length) {
          req.companyId = rows[0]!.company_id;
          return true;
        }
      }
    }

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
