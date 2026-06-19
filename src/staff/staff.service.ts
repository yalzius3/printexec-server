import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";

const CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateToken(): string {
  let t = "";
  for (let i = 0; i < 8; i++) {
    if (i === 4) t += "-";
    t += CHARSET[Math.floor(Math.random() * CHARSET.length)];
  }
  return t;
}

export interface StaffMember {
  id: string;
  email: string;
  display_name: string | null;
  role: "owner" | "staff";
  permissions: Record<string, boolean>;
  monthly_salary: string | null;
  created_at: string;
}

export interface InviteRow {
  token: string;
  created_by_name: string | null;
  expires_at: string;
  created_at?: string;
}

@Injectable()
export class StaffService {
  constructor(private readonly db: DatabaseService) {}

  async listStaff(companyId: string): Promise<StaffMember[]> {
    const { rows } = await this.db.query<StaffMember>(
      `SELECT id, email, display_name, role, permissions, monthly_salary, created_at
       FROM users
       WHERE company_id = $1
       ORDER BY role DESC, created_at ASC`,
      [companyId]
    );
    return rows;
  }

  async getStaffMember(companyId: string, userId: string): Promise<StaffMember> {
    const { rows } = await this.db.query<StaffMember>(
      `SELECT id, email, display_name, role, permissions, monthly_salary, created_at
       FROM users WHERE company_id = $1 AND id = $2`,
      [companyId, userId]
    );
    if (!rows.length) throw new NotFoundException("Staff member not found.");
    return rows[0]!;
  }

  // Set (or clear, with null) a member's monthly salary. Nullable money field —
  // no other member data is touched.
  async updateSalary(
    companyId: string,
    targetId: string,
    monthlySalary: number | null
  ): Promise<StaffMember> {
    if (monthlySalary !== null && (!Number.isFinite(monthlySalary) || monthlySalary < 0)) {
      throw new BadRequestException("monthly_salary must be a non-negative number or null.");
    }
    // Ensures the member exists in this company before the write.
    await this.getStaffMember(companyId, targetId);

    const { rows } = await this.db.query<StaffMember>(
      `UPDATE users SET monthly_salary = $1
       WHERE id = $2 AND company_id = $3
       RETURNING id, email, display_name, role, permissions, monthly_salary, created_at`,
      [monthlySalary, targetId, companyId]
    );
    return rows[0]!;
  }

  async updatePermissions(
    companyId: string,
    requesterId: string,
    requesterRole: string,
    targetId: string,
    permissions: Record<string, boolean>
  ): Promise<StaffMember> {
    const target = await this.getStaffMember(companyId, targetId);

    if (target.role === "owner") {
      throw new ForbiddenException("Cannot modify owner permissions.");
    }

    // Only owners can grant can_manage_permissions
    if (permissions.can_manage_permissions && requesterRole !== "owner") {
      throw new ForbiddenException("Only owners can grant permission management rights.");
    }

    const { rows } = await this.db.query<StaffMember>(
      `UPDATE users SET permissions = $1
       WHERE id = $2 AND company_id = $3
       RETURNING id, email, display_name, role, permissions, monthly_salary, created_at`,
      [JSON.stringify(permissions), targetId, companyId]
    );
    return rows[0]!;
  }

  async removeStaffMember(
    companyId: string,
    requesterId: string,
    targetId: string
  ): Promise<void> {
    if (requesterId === targetId) {
      throw new ForbiddenException("Cannot remove yourself.");
    }
    const target = await this.getStaffMember(companyId, targetId);
    if (target.role === "owner") {
      throw new ForbiddenException("Cannot remove the owner.");
    }
    await this.db.query(
      "DELETE FROM users WHERE id = $1 AND company_id = $2",
      [targetId, companyId]
    );
  }

  async listInvites(companyId: string): Promise<InviteRow[]> {
    const { rows } = await this.db.query<InviteRow>(
      `SELECT ci.token, u.display_name AS created_by_name, ci.expires_at
       FROM company_invites ci
       JOIN users u ON u.id = ci.created_by
       WHERE ci.company_id = $1
         AND ci.used_at IS NULL
         AND ci.expires_at > now()
       ORDER BY ci.expires_at ASC`,
      [companyId]
    );
    return rows;
  }

  async createInvite(companyId: string, createdBy: string): Promise<InviteRow> {
    // Avoid collisions
    let token = generateToken();
    let tries = 0;
    while (tries++ < 10) {
      const { rows } = await this.db.query(
        "SELECT 1 FROM company_invites WHERE token = $1",
        [token]
      );
      if (!rows.length) break;
      token = generateToken();
    }

    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

    await this.db.query(
      `INSERT INTO company_invites (token, company_id, created_by, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [token, companyId, createdBy, expiresAt]
    );

    const { rows } = await this.db.query<InviteRow>(
      `SELECT ci.token, u.display_name AS created_by_name, ci.expires_at
       FROM company_invites ci
       JOIN users u ON u.id = ci.created_by
       WHERE ci.token = $1`,
      [token]
    );
    return rows[0]!;
  }

  async revokeInvite(companyId: string, token: string): Promise<void> {
    const { rowCount } = await this.db.query(
      "DELETE FROM company_invites WHERE token = $1 AND company_id = $2",
      [token, companyId]
    );
    if (!rowCount) throw new NotFoundException("Invite not found.");
  }
}
