import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { DatabaseService } from "../database/database.service";

// ════════════════════════════════════════════════════════════════
// COMPANY PURGE — platform-admin "delete" that actually deletes.
//
// The old admin delete was a soft delete (companies.deleted_at): the tenant was
// locked out but every row survived, so the company still showed in the admin
// console forever, and a fresh signup on the same email produced a confusing
// duplicate pair (old ghost + new tenant). Deletion is now real:
//
//   1. Snapshot the member account ids BEFORE the delete (the membership rows
//      are about to cascade away).
//   2. DELETE FROM companies — every tenant table cascades with it (see
//      migrations/2026-07-21_company_hard_delete.sql, which normalises the
//      legacy non-cascading foreign keys).
//   3. Delete the Supabase auth account of any member who is now orphaned —
//      i.e. belongs to NO remaining company. That frees the email address so a
//      re-signup is a clean new account rather than a duplicate. Members who
//      still belong to another workspace keep their login.
//
// Step 3 is best-effort: the tenant data is already gone by then, so an auth
// API failure is logged and reported, never rolled back (we cannot un-delete
// the company anyway). The caller surfaces the counts to the admin.
//
// IRREVERSIBLE. The admin UI gates this behind a type-the-company-name
// confirmation.
// ════════════════════════════════════════════════════════════════

export interface PurgeResult {
  ok: boolean;
  company_name: string;
  /** Auth accounts deleted because they had no other workspace left. */
  accounts_deleted: number;
  /** Auth accounts kept because the person still belongs to another workspace. */
  accounts_kept: number;
  /** Non-fatal problems (auth API failures) worth showing the admin. */
  warnings: string[];
}

@Injectable()
export class CompanyPurgeService {
  private readonly logger = new Logger(CompanyPurgeService.name);
  private supabase: SupabaseClient | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService
  ) {}

  /** Lazily built admin client; null when service-role credentials are absent. */
  private adminClient(): SupabaseClient | null {
    if (this.supabase) return this.supabase;
    const url = this.config.get<string>("SUPABASE_URL");
    const key = this.config.get<string>("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return null;
    this.supabase = createClient(url, key);
    return this.supabase;
  }

  /**
   * Permanently delete a company and everything belonging to it. Returns null
   * when the company doesn't exist (already gone / bad id).
   */
  async purge(companyId: string): Promise<PurgeResult | null> {
    const { rows: companyRows } = await this.db.query<{ name: string }>(
      "SELECT name FROM companies WHERE company_id = $1",
      [companyId]
    );
    const company = companyRows[0];
    if (!company) return null;

    // 1. Member account ids, captured before the cascade removes them.
    const { rows: memberRows } = await this.db.query<{ account_id: string }>(
      "SELECT account_id FROM company_memberships WHERE company_id = $1",
      [companyId]
    );
    const memberIds = memberRows.map((r) => r.account_id).filter(Boolean);

    // 2. The delete itself. Children cascade; if a legacy foreign key still
    //    blocks it, the error surfaces to the admin rather than half-deleting.
    await this.db.query("DELETE FROM companies WHERE company_id = $1", [companyId]);

    // 3. Orphaned logins. Anyone still holding a membership elsewhere keeps
    //    their account.
    const warnings: string[] = [];
    let deleted = 0;
    let kept = 0;

    if (memberIds.length > 0) {
      const { rows: stillMembers } = await this.db.query<{ account_id: string }>(
        "SELECT DISTINCT account_id FROM company_memberships WHERE account_id = ANY($1::uuid[])",
        [memberIds]
      );
      const stillActive = new Set(stillMembers.map((r) => r.account_id));
      const orphaned = memberIds.filter((id) => !stillActive.has(id));
      kept = memberIds.length - orphaned.length;

      const client = this.adminClient();
      if (orphaned.length > 0 && !client) {
        warnings.push(
          `${orphaned.length} sign-in account(s) could not be removed: Supabase service-role credentials are not configured on the API.`
        );
      } else {
        for (const accountId of orphaned) {
          try {
            const { error } = await client!.auth.admin.deleteUser(accountId);
            if (error) throw new Error(error.message);
            deleted += 1;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            warnings.push(`Sign-in account ${accountId} could not be removed: ${msg}`);
            this.logger.warn(`purge ${companyId}: auth delete failed for ${accountId}: ${msg}`);
          }
        }
      }
    }

    this.logger.log(
      `purged company ${companyId} ("${company.name}") — ${deleted} account(s) deleted, ${kept} kept, ${warnings.length} warning(s)`
    );

    return {
      ok: true,
      company_name: company.name,
      accounts_deleted: deleted,
      accounts_kept: kept,
      warnings
    };
  }
}
