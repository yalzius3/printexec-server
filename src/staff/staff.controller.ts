import {
  Body, Controller, Delete,
  Get, Param, Patch, Post
} from "@nestjs/common";
import { CompanyId } from "../common/company-id.decorator";
import { RequirePermission } from "../auth/permission.decorator";
import { StaffService } from "./staff.service";
import type { AuthRequest } from "../auth/supabase.guard";
import { createParamDecorator, type ExecutionContext } from "@nestjs/common";

const RequestUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) =>
    ctx.switchToHttp().getRequest<AuthRequest>()
);

@Controller("staff")
export class StaffController {
  constructor(private readonly staffService: StaffService) {}

  @Get()
  listStaff(@CompanyId() companyId: string) {
    return this.staffService.listStaff(companyId);
  }

  @Get(":userId")
  getStaffMember(
    @CompanyId() companyId: string,
    @Param("userId") userId: string
  ) {
    return this.staffService.getStaffMember(companyId, userId);
  }

  @Patch(":userId/permissions")
  @RequirePermission(
    "can_manage_permissions",
    "You do not have permission to manage staff permissions."
  )
  updatePermissions(
    @CompanyId() companyId: string,
    @RequestUser() req: AuthRequest,
    @Param("userId") targetId: string,
    @Body() body: { permissions: Record<string, boolean> }
  ) {
    return this.staffService.updatePermissions(
      companyId,
      req.userId,
      req.userRole,
      targetId,
      body.permissions
    );
  }

  @Delete(":userId")
  @RequirePermission(
    "can_manage_permissions",
    "You do not have permission to remove staff members."
  )
  removeStaffMember(
    @CompanyId() companyId: string,
    @RequestUser() req: AuthRequest,
    @Param("userId") targetId: string
  ) {
    return this.staffService.removeStaffMember(companyId, req.userId, targetId);
  }

  @Get("invites/list")
  listInvites(@CompanyId() companyId: string) {
    return this.staffService.listInvites(companyId);
  }

  @Post("invites")
  @RequirePermission(
    "can_send_invites",
    "You do not have permission to send invites."
  )
  createInvite(
    @CompanyId() companyId: string,
    @RequestUser() req: AuthRequest
  ) {
    return this.staffService.createInvite(companyId, req.userId);
  }

  @Delete("invites/:token")
  @RequirePermission(
    "can_send_invites",
    "You do not have permission to revoke invites."
  )
  revokeInvite(
    @CompanyId() companyId: string,
    @Param("token") token: string
  ) {
    return this.staffService.revokeInvite(companyId, token);
  }
}
