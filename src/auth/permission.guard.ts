import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PERMISSION_KEY, type PermissionMeta } from "./permission.decorator";
import type { AuthRequest } from "./supabase.guard";

/**
 * Runs after SupabaseAuthGuard. If a route is decorated with
 * @RequirePermission('foo'), this guard checks that:
 *   - the requester is an owner (full bypass), OR
 *   - req.permissions[foo] === true
 *
 * Otherwise throws 403 with the route's custom message (or a default).
 * Routes without the decorator are unaffected.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const meta = this.reflector.getAllAndOverride<PermissionMeta | undefined>(
      PERMISSION_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!meta) return true;

    const req = ctx.switchToHttp().getRequest<AuthRequest>();
    if (req.userRole === "owner") return true;
    if (req.permissions?.[meta.permission] === true) return true;

    throw new ForbiddenException(
      meta.message ?? `Missing required permission: ${meta.permission}`,
    );
  }
}
