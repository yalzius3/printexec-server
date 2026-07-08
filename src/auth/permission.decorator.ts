import { SetMetadata } from "@nestjs/common";

export const PERMISSION_KEY = "requiredPermission";

export interface PermissionMeta {
  /** Passing ANY ONE of these permissions grants access (owners always pass). */
  permissions: string[];
  message?: string;
}

/**
 * Marks a controller route as requiring a permission key
 * (e.g. "view_orders", "action_customers").
 *
 * Accepts a single key or an ANY-OF list. The list form exists for
 * cross-module METADATA reads: e.g. material pricing lives in the assets
 * module but powers order quotations, so it must be readable with EITHER
 * view_assets OR view_orders — a staff member locked out of Assets must
 * still be able to price an order. Access denial should kill only the
 * prohibited module itself, never the metadata other modules need.
 *
 * The PermissionGuard reads this metadata after SupabaseAuthGuard has
 * populated req.permissions and req.userRole. Owners always pass.
 *
 * Optional `message` lets a route surface its own ForbiddenException text
 * (preserves the original wording when consolidating per-endpoint checks).
 */
export const RequirePermission = (
  permission: string | string[],
  message?: string
) =>
  SetMetadata(PERMISSION_KEY, {
    permissions: Array.isArray(permission) ? permission : [permission],
    message
  } as PermissionMeta);
