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
import {
  canonicalizeInviteToken,
  generateInviteToken,
  inviteIsExpiredSql,
  inviteIsLiveSql
} from "./invite-token";

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
    // Removing someone has to take back the access they were handing out.
    // Their outstanding invite codes stayed redeemable for the rest of their
    // 48-hour window, so a member you had just removed could still walk a
    // stranger into the workspace.
    //
    // Only UNUSED codes go. A used row is the audit record of who joined and
    // on whose invite; destroying that would lose history, and used_by still
    // points at a real account.
    //
    // One transaction, invites FIRST. If company_invites.created_by restricts
    // deletes, clearing these rows is what lets the users row go at all — and
    // if the users delete then fails, the revocation rolls back with it rather
    // than destroying codes belonging to someone who is still on the team.
    await this.db.transaction(async (client) => {
      await this.db.query(
        `DELETE FROM company_invites
          WHERE company_id = $1 AND created_by = $2 AND used_at IS NULL`,
        [companyId, targetId],
        client
      );
      // The USED rows stay — they are the record of who joined. But if
      // company_invites.created_by RESTRICTs deletes, they are also what stops
      // the users row going at all, and removing anyone who had ever issued a
      // redeemed code fails with a foreign-key violation. (That is pre-existing:
      // the plain delete below has always hit it. The schema is not in this
      // repo, so which variant production runs is unknown — see
      // scripts/inspect-invites.sql.) Retry once with the reference released.
      //
      // A SAVEPOINT rather than a bare try/catch: in Postgres the first error
      // aborts the entire transaction, so without one the retry would run
      // inside a failed transaction and die too. Rolling back to the savepoint
      // does NOT undo the invite revocation above — that happened before it.
      //
      // Nulling created_by loses nothing still readable: the creator's users
      // row is being deleted in the same breath, so every caller already
      // resolves that name to null through a LEFT JOIN.
      await this.db.query("SAVEPOINT before_member_delete", [], client);
      try {
        await this.db.query(
          "DELETE FROM users WHERE id = $1 AND company_id = $2",
          [targetId, companyId],
          client
        );
      } catch {
        await this.db.query("ROLLBACK TO SAVEPOINT before_member_delete", [], client);
        await this.db.query(
          `UPDATE company_invites SET created_by = NULL
            WHERE company_id = $1 AND created_by = $2 AND used_at IS NOT NULL`,
          [companyId, targetId],
          client
        );
        await this.db.query(
          "DELETE FROM users WHERE id = $1 AND company_id = $2",
          [targetId, companyId],
          client
        );
      }
    });
  }

  async listInvites(companyId: string): Promise<InviteRow[]> {
    const { rows } = await this.db.query<InviteRow>(
      // LEFT JOIN, not JOIN. An inner join silently DROPPED every invite whose
      // creator had since been removed from the company — so codes that were
      // still live and still redeemable disappeared from this list, and the
      // owner had no way to see or revoke them. The creator's name is a label;
      // losing it must not lose the row. created_by_name is already typed
      // `string | null` on both sides and is not rendered, so a null is inert.
      `SELECT ci.token, u.display_name AS created_by_name, ci.expires_at
       FROM company_invites ci
       LEFT JOIN users u ON u.id = ci.created_by
       WHERE ci.company_id = $1
         AND ci.used_at IS NULL
         AND ${inviteIsLiveSql("ci.expires_at")}
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

    // Expiry is computed BY THE DATABASE, not by this process. It used to be
    // `new Date(Date.now() + 48h).toISOString()` — a string ending in Z — and
    // if company_invites.expires_at is a naive `timestamp` rather than
    // `timestamptz`, Postgres silently drops that Z on the cast and stores a
    // bare wall-clock time. The window then lands 48 hours off the API
    // process's clock rather than off the database's, and every later
    // comparison resolves it in whatever timezone the reading session happens
    // to use. Writing `now() + interval` puts the write and all three reads on
    // one clock, whatever the column type turns out to be.
    // See scripts/inspect-invites.sql.
    await this.db.query(
      `INSERT INTO company_invites (token, company_id, created_by, expires_at)
       VALUES ($1, $2, $3, now() + interval '48 hours')`,
      [token, companyId, createdBy]
    );

    const { rows } = await this.db.query<InviteRow>(
      // LEFT JOIN for the same reason as listInvites — and here it also makes
      // the non-null assertion below honest. With an inner join this SELECT
      // could return nothing for an invite that had just been written
      // successfully, handing the client `undefined` as its new code.
      `SELECT ci.token, u.display_name AS created_by_name, ci.expires_at
       FROM company_invites ci
       LEFT JOIN users u ON u.id = ci.created_by
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
      is_expired: boolean;
      created_by_name: string | null;
      company_name: string;
    }>(
      // is_expired is decided by the DATABASE, with the exact complement of
      // the predicate listInvites filters on — see invite-token.ts. It used to
      // be re-derived here in JS from the returned value, which only agrees
      // with the list if expires_at is timestamptz. expires_at itself is still
      // selected because the email body prints it.
      `SELECT ci.token, ci.expires_at, ci.used_at,
              ${inviteIsExpiredSql("ci.expires_at")} AS is_expired,
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
    if (invite.is_expired) {
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
