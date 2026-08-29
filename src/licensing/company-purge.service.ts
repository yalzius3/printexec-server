import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { DatabaseService } from "../database/database.service";
import { StorageFilesService } from "../storage/storage-files.service";

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
//   4. Delete the tenant's FILES from object storage.
//
// Step 3 is best-effort: the tenant data is already gone by then, so an auth
// API failure is logged and reported, never rolled back (we cannot un-delete
// the company anyway). The caller surfaces the counts to the admin.
//
// ── WHY STEP 4 EXISTS, AND WHY IT IS ORDERED THE WAY IT IS ──────────────────
// Until it did, deleting a tenant deleted every ROW and kept every BYTE. Worse
// than a leak: the rows naming those objects cascaded away with the company, so
// the files became not just unreferenced but unnameable — nothing left in the
// database could ever say which bytes belonged to whom. The only surviving
// evidence was the key prefix.
//
// That prefix is what makes this tractable. Object keys are
// "<companyId>/<uuid><ext>" (uploads.controller.ts), so the prefix IS the
// tenant boundary and a prefix sweep is exactly a tenant sweep.
//
// The key list is read BEFORE the DELETE. Not for correctness — the prefix does
// not change and a purged tenant cannot upload — but so that an unreadable
// storage.objects is discovered while there is still something useful to say
// about it, and reported as a warning instead of silently reclaiming nothing.
//
// Deliberately NOT filtered through unreferencedKeys(): that guard exists to
// stop one row's delete destroying bytes a SIBLING row still needs, and here
// there are no siblings left — the whole tenant is gone. Running it would cost
// a full scan to answer a question with only one possible answer, and in the
// one pathological case where another tenant holds a stale pointer into this
// prefix it would give the WRONG answer: keep the file forever, unreachable
// (the upload route refuses any key outside the caller's own prefix) and now
// undeletable, because the company that could name it no longer exists.
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
  /** Stored files removed from the bucket with the tenant. */
  files_removed: number;
  /** True when some of the tenant's bytes could not be removed — the keys are
   *  in the API log, and they are now unreachable by any other means. */
  files_orphaned: boolean;
  /** Non-fatal problems (auth API / storage failures) worth showing the admin. */
  warnings: string[];
}

@Injectable()
export class CompanyPurgeService {
  private readonly logger = new Logger(CompanyPurgeService.name);
  private supabase: SupabaseClient | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    private readonly storage: StorageFilesService
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

    const warnings: string[] = [];

    // 1b. The tenant's object keys, read while the database is still intact.
    //     A failure here must NOT abort the purge: the admin asked for this
    //     tenant to be gone, and refusing to delete a workspace because the
    //     storage catalogue was briefly unreadable would be the wrong trade.
    //     It is reported instead, because unswept bytes under a dead prefix are
    //     the exact thing this step exists to prevent.
    let storageKeys: string[] = [];
    try {
      storageKeys = await this.storage.keysForCompany(companyId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warnings.push(
        `Stored files could not be listed, so none were deleted — they remain in the bucket under prefix ${companyId}/ and must be removed by hand: ${msg}`
      );
      this.logger.error(`purge ${companyId}: storage key listing failed: ${msg}`);
    }

    // 2. The delete itself. Children cascade; if a legacy foreign key still
    //    blocks it, the error surfaces to the admin rather than half-deleting.
    await this.db.query("DELETE FROM companies WHERE company_id = $1", [companyId]);

    // 3. Orphaned logins. Anyone still holding a membership elsewhere keeps
    //    their account.
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

    // 4. The bytes. Runs last, after the rows are gone: a bucket delete cannot
    //    be rolled back, so doing it earlier would destroy files for a tenant a
    //    later failure leaves standing. removeObjects never throws — see the
    //    note on it — and logs the keys of anything it could not remove.
    const files = await this.storage.removeObjects(storageKeys);
    if (files.failed) {
      warnings.push(
        `Some stored files could not be deleted and remain in the bucket under prefix ${companyId}/. The API log lists the exact keys.`
      );
    }

    this.logger.log(
      `purged company ${companyId} ("${company.name}") — ${deleted} account(s) deleted, ` +
        `${kept} kept, ${files.removed}/${storageKeys.length} file(s) removed, ` +
        `${warnings.length} warning(s)`
    );

    return {
      ok: true,
      company_name: company.name,
      accounts_deleted: deleted,
      accounts_kept: kept,
      files_removed: files.removed,
      files_orphaned: files.failed,
      warnings
    };
  }
}
