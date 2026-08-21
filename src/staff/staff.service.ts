import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ServiceUnavailableException
} from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { emailAppUrl } from "../email/app-url";
import { EmailService } from "../email/email.service";
import { composeStaffInviteEmail } from "../email/email-templates";
import { canonicalizeInviteToken, generateInviteToken } from "./invite-token";

// The code format lives in ONE module now — minting here and matching in
// auth.controller's redemption path have to agree, and they did not before.
// See invite-token.ts. Re-exported so any future import site can reach either
// half through the service, as jobs.service.ts does for the matching kernel.
export { canonicalizeInviteToken, generateInviteToken };

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
  constructor(
    private readonly db: DatabaseService,
    private readonly email: EmailService
  ) {}

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
    // Avoid collisions. The loop below used to check ten candidates, mint an
    // ELEVENTH on the last failing pass, and then fall out and insert that one
    // unchecked — so the one token guaranteed never to have been tested was the
    // one that got written. Astronomically unlikely at 32^8, but the failure it
    // produces is silent-wrong-answer rather than an error: with no unique
    // constraint a duplicate row lands, and redemption reads rows[0] with no
    // ORDER BY, so a live code can come back "already used". Claim a token only
    // once it has actually passed a check.
    let token = "";
    for (let tries = 0; tries < 10; tries++) {
      const candidate = generateInviteToken();
      const { rows } = await this.db.query(
        "SELECT 1 FROM company_invites WHERE token = $1",
        [candidate]
      );
      if (!rows.length) {
        token = candidate;
        break;
      }
    }
    if (!token) {
      throw new ServiceUnavailableException(
        "Could not allocate an invite code just now. Please try again."
      );
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

  /**
   * Email an existing, still-usable invite code to the invitee. Uses the same
   * no-reply transport (and EMAIL_ENABLED dry-run gate) as customer emails.
   * Returns the transport outcome so the client can phrase its confirmation.
   */
  async emailInvite(
    companyId: string,
    token: string,
    recipientEmail: string
  ): Promise<{ status: "sent" | "dry_run" }> {
    const { rows } = await this.db.query<{
      token: string;
      expires_at: string;
      used_at: string | null;
      created_by_name: string | null;
      company_name: string;
    }>(
      `SELECT ci.token, ci.expires_at, ci.used_at,
              u.display_name AS created_by_name,
              c.name AS company_name
         FROM company_invites ci
         JOIN companies c ON c.company_id = ci.company_id
         LEFT JOIN users u ON u.id = ci.created_by
        WHERE ci.token = $1 AND ci.company_id = $2`,
      [token, companyId]
    );
    const invite = rows[0];
    if (!invite) throw new NotFoundException("Invite not found.");
    if (invite.used_at) {
      throw new BadRequestException("This invite code has already been used.");
    }
    if (new Date(invite.expires_at).getTime() < Date.now()) {
      throw new BadRequestException("This invite code has expired — create a new one.");
    }

    // The invite CTA must open the APP (join flow), not the marketing site —
    // and never a CORS/preview origin. See email/app-url.ts.
    const appUrl = emailAppUrl();

    const message = composeStaffInviteEmail({
      companyName: invite.company_name,
      inviteToken: invite.token,
      expiresAt: invite.expires_at,
      invitedByName: invite.created_by_name,
      appUrl
    });

    const status = await this.email.send({
      to: recipientEmail,
      subject: message.subject,
      text: message.text,
      html: message.html
    });
    return { status };
  }
}
