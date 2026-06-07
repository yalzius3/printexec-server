import { SetMetadata } from "@nestjs/common";

export const PERMISSION_KEY = "requiredPermission";

export interface PermissionMeta {
  permission: string;
  message?: string;
}

/**
 * Marks a controller route as requiring a specific permission key
 * (e.g. "view_orders", "action_customers").
 *
 * The PermissionGuard reads this metadata after SupabaseAuthGuard has
 * populated req.permissions and req.userRole. Owners always pass.
 *
 * Optional `message` lets a route surface its own ForbiddenException text
 * (preserves the original wording when consolidating per-endpoint checks).
 */
export const RequirePermission = (permission: string, message?: string) =>
  SetMetadata(PERMISSION_KEY, { permission, message } as PermissionMeta);
