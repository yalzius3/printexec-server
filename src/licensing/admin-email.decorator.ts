import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { AdminRequest } from "./platform-admin.guard";

/**
 * The allow-listed email of the platform admin making this request, as
 * resolved and verified by PlatformAdminGuard. Always present on admin routes
 * (the guard rejects everything else), so handlers can attribute an action
 * without re-querying the users table.
 */
export const AdminEmail = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<AdminRequest>();
  return req.adminEmail;
});
