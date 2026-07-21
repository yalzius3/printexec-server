import { ForbiddenException, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

// ════════════════════════════════════════════════════════════════
// Platform-admin step-up authentication.
//
// The licensing admin is the monetization surface (plan assignment, printer
// caps, custom pricing, grant codes, discounts, company deletion), so an
// allow-listed email alone is not enough: a stolen Supabase session would
// otherwise hand an attacker the whole business. Access therefore needs BOTH
//
//   1. an email on PLATFORM_ADMIN_EMAILS  (something the account is), and
//   2. PLATFORM_ADMIN_SECRET              (something only the operator knows,
//                                          living in the deploy env — never in
//                                          the database, never in the client)
//
// Entering the secret mints a short-lived, HMAC-signed session token bound to
// that specific admin user id. Every admin request must carry it in the
// x-admin-session header; it expires on its own and is invalidated wholesale
// the moment the secret is rotated (the signing key is derived from it).
//
// FAIL CLOSED: if PLATFORM_ADMIN_SECRET is not configured the admin area is
// unavailable, rather than silently falling back to the weaker email-only
// gate. Locking yourself out is recoverable (set the env var); a wide-open
// billing console is not.
// ════════════════════════════════════════════════════════════════

interface AttemptRecord {
  failures: number;
  lockedUntil: number;
}

@Injectable()
export class AdminSessionService {
  private readonly logger = new Logger(AdminSessionService.name);

  private readonly secret: string;
  private readonly signingKey: Buffer;
  readonly ttlMs: number;
  private readonly maxAttempts: number;
  private readonly lockoutMs: number;

  /** Failed-unlock tracking, keyed by user id. Per-process, like the auth and
   *  license caches — a restart clears it, which is an acceptable trade for a
   *  single-instance deployment. */
  private readonly attempts = new Map<string, AttemptRecord>();

  constructor(config: ConfigService) {
    this.secret = (config.get<string>("PLATFORM_ADMIN_SECRET") ?? "").trim();
    this.ttlMs =
      (Number(config.get<string>("PLATFORM_ADMIN_SESSION_MINUTES")) || 30) * 60_000;
    this.maxAttempts = Number(config.get<string>("PLATFORM_ADMIN_MAX_ATTEMPTS")) || 5;
    this.lockoutMs =
      (Number(config.get<string>("PLATFORM_ADMIN_LOCKOUT_MINUTES")) || 15) * 60_000;

    // Signing key = SHA-256 over the admin secret + the service-role key. Two
    // consequences we want: the token can't be forged without server-side
    // material, and rotating either secret invalidates every live session.
    const serviceKey = config.get<string>("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    this.signingKey = createHash("sha256")
      .update(`px-admin-session|${this.secret}|${serviceKey}`)
      .digest();

    if (!this.secret) {
      this.logger.warn(
        "PLATFORM_ADMIN_SECRET is not set — the platform licensing admin is DISABLED. Set it to enable the admin area."
      );
    }
  }

  /** Whether the admin area can be unlocked at all (secret configured). */
  get enabled(): boolean {
    return this.secret.length > 0;
  }

  /** Remaining lockout in ms for this admin, or 0 when not locked out. */
  private lockoutRemaining(userId: string): number {
    const rec = this.attempts.get(userId);
    if (!rec) return 0;
    const left = rec.lockedUntil - Date.now();
    if (left <= 0) {
      // Lockout served — reset so the next attempt starts clean.
      if (rec.lockedUntil !== 0) this.attempts.delete(userId);
      return 0;
    }
    return left;
  }

  private recordFailure(userId: string): void {
    const rec = this.attempts.get(userId) ?? { failures: 0, lockedUntil: 0 };
    rec.failures += 1;
    if (rec.failures >= this.maxAttempts) {
      rec.lockedUntil = Date.now() + this.lockoutMs;
      rec.failures = 0;
      this.logger.warn(`Admin unlock locked out for user ${userId} (too many failed attempts).`);
    }
    this.attempts.set(userId, rec);
  }

  /**
   * Exchange the admin passphrase for a session token. Throws Forbidden on a
   * bad secret or during a lockout, ServiceUnavailable when the admin area is
   * not configured at all.
   */
  unlock(userId: string, providedSecret: string): { token: string; expiresAt: string } {
    if (!this.enabled) {
      throw new ServiceUnavailableException(
        "The admin area is not configured on this deployment (PLATFORM_ADMIN_SECRET is unset)."
      );
    }

    const lockedFor = this.lockoutRemaining(userId);
    if (lockedFor > 0) {
      const mins = Math.ceil(lockedFor / 60_000);
      throw new ForbiddenException(
        `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`
      );
    }

    if (!this.matchesSecret(providedSecret)) {
      this.recordFailure(userId);
      throw new ForbiddenException("That passphrase is incorrect.");
    }

    // Success — clear any accumulated failures.
    this.attempts.delete(userId);

    const expiresAt = Date.now() + this.ttlMs;
    return { token: this.sign(userId, expiresAt), expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Constant-time secret comparison (never leaks length/prefix via timing). */
  private matchesSecret(provided: string): boolean {
    const a = Buffer.from(String(provided ?? ""), "utf8");
    const b = Buffer.from(this.secret, "utf8");
    // timingSafeEqual requires equal lengths, so compare fixed-size digests
    // of both sides instead of the raw bytes.
    const ah = createHash("sha256").update(a).digest();
    const bh = createHash("sha256").update(b).digest();
    return timingSafeEqual(ah, bh);
  }

  private sign(userId: string, expiresAt: number): string {
    // jti makes each token unique even for the same user+expiry second.
    const payload = Buffer.from(
      JSON.stringify({ u: userId, e: expiresAt, j: randomUUID() }),
      "utf8"
    ).toString("base64url");
    const sig = createHmac("sha256", this.signingKey).update(payload).digest("base64url");
    return `${payload}.${sig}`;
  }

  /**
   * Validate a session token against the admin making the request. Returns the
   * expiry when valid, or null for anything wrong (bad shape, bad signature,
   * expired, or issued for a different user).
   */
  verify(token: string | undefined | null, userId: string): { expiresAt: number } | null {
    if (!this.enabled || !token) return null;
    const [payload, sig] = String(token).split(".");
    if (!payload || !sig) return null;

    const expected = createHmac("sha256", this.signingKey).update(payload).digest("base64url");
    const a = Buffer.from(sig, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    try {
      const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
        u?: string;
        e?: number;
      };
      // Bind the token to the authenticated user: an admin's token is useless
      // on another admin's account.
      if (!decoded.u || decoded.u !== userId) return null;
      if (typeof decoded.e !== "number" || decoded.e <= Date.now()) return null;
      return { expiresAt: decoded.e };
    } catch {
      return null;
    }
  }
}
