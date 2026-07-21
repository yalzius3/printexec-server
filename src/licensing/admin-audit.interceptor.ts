import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor
} from "@nestjs/common";
import type { Observable } from "rxjs";
import { catchError, tap } from "rxjs/operators";
import { DatabaseService } from "../database/database.service";
import type { AdminRequest } from "./platform-admin.guard";

// Body keys never worth persisting (and in one case never worth storing at
// all). "secret" is the admin passphrase from the unlock route.
const REDACTED_KEYS = new Set(["secret", "password", "token"]);

/**
 * Append-only audit trail for the platform-admin area. Licensing actions move
 * money and revoke access, so every mutation is attributed: who ran it, what
 * route, which company, the (redacted) request body, and whether it succeeded.
 *
 * Reads (GET) are not logged — they're high-volume and carry no consequence.
 * Writes are logged on success AND on failure, so a burst of rejected attempts
 * is visible after the fact.
 *
 * Best-effort by construction: a logging failure (e.g. the table not migrated
 * yet) is warned about and swallowed — auditing must never take the admin
 * area down.
 */
@Injectable()
export class AdminAuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AdminAuditInterceptor.name);

  constructor(private readonly db: DatabaseService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<
      AdminRequest & {
        method?: string;
        url?: string;
        body?: unknown;
        ip?: string;
      }
    >();

    const method = (req.method ?? "GET").toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      return next.handle();
    }

    const action = `${method} ${(req.url ?? "").split("?")[0]}`;
    const body = this.redact(req.body);
    const companyId = this.targetCompany(req.body);
    const ip = req.ip ?? null;
    const uaRaw = req.headers?.["user-agent"];
    const userAgent = (Array.isArray(uaRaw) ? uaRaw[0] : uaRaw)?.slice(0, 400) ?? null;

    return next.handle().pipe(
      tap(() => {
        void this.write(req, action, companyId, body, true, ip, userAgent);
      }),
      catchError((err: unknown) => {
        void this.write(
          req,
          action,
          companyId,
          { ...body, error: err instanceof Error ? err.message : String(err) },
          false,
          ip,
          userAgent
        );
        throw err;
      })
    );
  }

  /** Shallow-copy the body with sensitive keys masked. */
  private redact(body: unknown): Record<string, unknown> {
    if (!body || typeof body !== "object") return {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      out[k] = REDACTED_KEYS.has(k.toLowerCase()) ? "[redacted]" : v;
    }
    return out;
  }

  /** Pull the targeted company id out of the request body, when it names one. */
  private targetCompany(body: unknown): string | null {
    if (!body || typeof body !== "object") return null;
    const b = body as Record<string, unknown>;
    const single = b["company_id"];
    if (typeof single === "string") return single;
    // Bulk routes carry company_ids[]; record the first as the anchor and keep
    // the full list in details.
    const many = b["company_ids"];
    if (Array.isArray(many) && typeof many[0] === "string") return many[0];
    return null;
  }

  private async write(
    req: AdminRequest,
    action: string,
    companyId: string | null,
    details: Record<string, unknown>,
    ok: boolean,
    ip: string | null,
    userAgent: string | null
  ): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO platform_admin_audit
           (admin_user_id, admin_email, action, company_id, details, ok, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
        [
          req.userId ?? null,
          req.adminEmail ?? null,
          action,
          companyId,
          JSON.stringify(details ?? {}),
          ok,
          ip,
          userAgent
        ]
      );
    } catch (e) {
      this.logger.warn(
        `admin audit not recorded for "${action}" (migration pending?): ${e instanceof Error ? e.message : e}`
      );
    }
  }
}
