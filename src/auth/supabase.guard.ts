import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { DatabaseService } from "../database/database.service";

export const PUBLIC_KEY = "isPublic";

export interface AuthRequest {
  userId: string;
  companyId: string;
  userRole: "owner" | "staff";
  permissions: Record<string, boolean>;
  headers: Record<string, string | string[] | undefined>;
}

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  private readonly supabase: SupabaseClient;

  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
    private readonly db: DatabaseService
  ) {
    this.supabase = createClient(
      config.getOrThrow("SUPABASE_URL"),
      config.getOrThrow("SUPABASE_SERVICE_ROLE_KEY")
    );
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass()
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<AuthRequest & { headers: Record<string, string | string[]> }>();
    const raw = req.headers["authorization"];
    const authHeader = Array.isArray(raw) ? raw[0] : raw;

    if (!authHeader?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Missing authorization token.");
    }

    const token = authHeader.slice(7);
    const { data, error } = await this.supabase.auth.getUser(token);

    if (error || !data.user) {
      console.error("[guard] getUser failed:", { message: error?.message, status: error?.status, name: error?.name });
      throw new UnauthorizedException(`Invalid or expired token: ${error?.message ?? "no user"}`);
    }

    const { rows } = await this.db.query<{
      company_id: string;
      role: "owner" | "staff";
      permissions: Record<string, boolean>;
    }>(
      "SELECT company_id, role, permissions FROM users WHERE id = $1",
      [data.user.id]
    );

    if (!rows.length) {
      throw new UnauthorizedException("User profile not found. Complete setup first.");
    }

    const profile = rows[0]!;
    req.userId = data.user.id;
    req.companyId = profile.company_id;
    req.userRole = profile.role;
    req.permissions = profile.permissions;

    return true;
  }
}
