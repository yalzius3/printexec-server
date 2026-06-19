import {
  BadRequestException,
  Body, Controller, Delete, ForbiddenException,
  Get, Param, Patch, Post
} from "@nestjs/common";
import { z } from "zod";
import { CompanyId } from "../common/company-id.decorator";
import { RequirePermission } from "../auth/permission.decorator";
import { StaffService, type StaffMember } from "./staff.service";
import type { AuthRequest } from "../auth/supabase.guard";
import { createParamDecorator, type ExecutionContext } from "@nestjs/common";

const RequestUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) =>
    ctx.switchToHttp().getRequest<AuthRequest>()
);

// Monthly salary: a non-negative amount, or null to clear it.
const salarySchema = z.object({
  monthly_salary: z.coerce.number().min(0).max(100000000).nullable()
});

// Salary is owner-only data — drop it from member payloads for everyone else.
function stripSalary(member: StaffMember): StaffMember {
  const { monthly_salary: _omit, ...rest } = member;
  return rest as StaffMember;
}

@Controller("staff")
export class StaffController {
  constructor(private readonly staffService: StaffService) {}

  @Get()
  async listStaff(
    @CompanyId() companyId: string,
    @RequestUser() req: AuthRequest
  ) {
    const rows = await this.staffService.listStaff(companyId);
    return req.userRole === "owner" ? rows : rows.map(stripSalary);
  }

  @Get(":userId")
  async getStaffMember(
    @CompanyId() companyId: string,
    @RequestUser() req: AuthRequest,
    @Param("userId") userId: string
  ) {
    const member = await this.staffService.getStaffMember(companyId, userId);
    return req.userRole === "owner" ? member : stripSalary(member);
  }

  @Patch(":userId/permissions")
  @RequirePermission(
    "can_manage_permissions",
    "You do not have permission to manage staff permissions."
  )
  async updatePermissions(
    @CompanyId() companyId: string,
    @RequestUser() req: AuthRequest,
    @Param("userId") targetId: string,
    @Body() body: { permissions: Record<string, boolean> }
  ) {
    const member = await this.staffService.updatePermissions(
      companyId,
      req.userId,
      req.userRole,
      targetId,
      body.permissions
    );
    return req.userRole === "owner" ? member : stripSalary(member);
  }

  @Patch(":userId/salary")
  @RequirePermission(
    "can_manage_permissions",
    "You do not have permission to manage staff salaries."
  )
  updateSalary(
    @CompanyId() companyId: string,
    @RequestUser() req: AuthRequest,
    @Param("userId") targetId: string,
    @Body() body: unknown
  ) {
    // Salary is owner-only — even members who can manage permissions can't set it.
    if (req.userRole !== "owner") {
      throw new ForbiddenException("Only the company owner can manage salaries.");
    }
    const parsed = salarySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException("monthly_salary must be a non-negative number or null.");
    }
    return this.staffService.updateSalary(companyId, targetId, parsed.data.monthly_salary);
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
