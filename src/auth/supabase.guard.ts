import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { DatabaseService } from "../database/database.service";
import { verifyToken } from "./verify-token";

export const PUBLIC_KEY = "isPublic";

export interface AuthRequest {
  userId: string;
  companyId: string;
  userRole: "owner" | "staff";
  permissions: Record<string, boolean>;
  headers: Record<string, string | string[] | undefined>;
}

interface CachedProfile {
  company_id: string;
  role: "owner" | "staff";
  permissions: Record<string, boolean>;
}

// Deliberate staleness window: a user's company/role/permissions are cached for
// 3 minutes, so a permission/role/company change propagates within 180 seconds.
// This is an intentional, owner-approved tradeoff — do not change the value.
// The cache is per-process: multiple API instances each cache independently,
// which is acceptable for now.
const PROFILE_TTL_MS = 180_000;

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  // Supabase project URL + anon key — used by verifyToken to reach the JWKS for
  // local verification. getOrThrow so a missing value fails LOUDLY at startup.
  private readonly supabaseUrl: string;
  private readonly supabaseAnonKey: string;

  // Tiny in-memory TTL cache keyed by userId. Expired entries are evicted lazily
  // on read, so there's no background timer to manage.
  private readonly profileCache = new Map<
    string,
    { value: CachedProfile; expiresAt: number }
  >();

  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
    private readonly db: DatabaseService
  ) {
    this.supabaseUrl = config.getOrThrow<string>("SUPABASE_URL");
    this.supabaseAnonKey = config.getOrThrow<string>("SUPABASE_ANON_KEY");
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

    // Verify the token (local against the cached JWKS once on asymmetric keys).
    const token = authHeader.slice(7);
    const { userId } = await verifyToken(token, this.supabaseUrl, this.supabaseAnonKey);

    const profile = await this.getProfile(userId);
    if (!profile) {
      throw new UnauthorizedException("User profile not found. Complete setup first.");
    }

    req.userId = userId;
    req.companyId = profile.company_id;
    req.userRole = profile.role;
    req.permissions = profile.permissions;

    return true;
  }

  // Cached profile lookup. On a hit (within the TTL) we skip the DB query.
  private async getProfile(userId: string): Promise<CachedProfile | null> {
    const hit = this.profileCache.get(userId);
    if (hit) {
      if (hit.expiresAt > Date.now()) return hit.value;
      // Lazily evict the expired entry.
      this.profileCache.delete(userId);
    }

    const { rows } = await this.db.query<CachedProfile>(
      "SELECT company_id, role, permissions FROM users WHERE id = $1",
      [userId]
    );
    if (!rows.length) return null;

    const profile = rows[0]!;
    this.profileCache.set(userId, {
      value: profile,
      expiresAt: Date.now() + PROFILE_TTL_MS
    });
    return profile;
  }
}
