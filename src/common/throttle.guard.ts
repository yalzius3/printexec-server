import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  SetMetadata
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AuthRequest } from "../auth/supabase.guard";
import { evaluateThrottle, type ThrottleWindowOptions } from "./throttle-window";

// ════════════════════════════════════════════════════════════════
// Request throttling.
//
// Hand-rolled rather than @nestjs/throttler on purpose: this needs exactly one
// behaviour, the codebase already hand-rolls its security primitives (the
// HMAC session tokens, the admin unlock lockout), and a package would still
// need a shared store to survive more than one instance — the same problem
// this has, without the added dependency surface.
//
// WHAT THIS IS NOT. It is per-process and in-memory, so N API instances allow
// N times the configured budget, and a restart clears every counter. That is
// the same trade AdminSessionService and SupabaseAuthGuard already make. It
// raises the cost of an attack; it does not make one impossible. Moving the
// counters to Postgres or Redis is the fix when this deployment stops being a
// single instance — until then, do not describe this as a hard limit.
// ════════════════════════════════════════════════════════════════

export const THROTTLE_KEY = "throttleOptions";

export type ThrottleOptions = ThrottleWindowOptions;

/**
 * Rate-limit a controller or a single route. Route metadata overrides class
 * metadata, so a controller can set a generous default and one sensitive route
 * can tighten it.
 */
export const Throttle = (options: ThrottleOptions) =>
  SetMetadata(THROTTLE_KEY, options);

/** One caller's timestamps inside the current window. */
type Hits = number[];

/** Stop the map growing without bound; swept lazily, never on a timer. */
const SWEEP_EVERY_N_REQUESTS = 500;

@Injectable()
export class ThrottleGuard implements CanActivate {
  private readonly logger = new Logger(ThrottleGuard.name);
  private readonly buckets = new Map<string, Hits>();
  private sinceSweep = 0;

  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const options = this.reflector.getAllAndOverride<ThrottleOptions | undefined>(
      THROTTLE_KEY,
      [ctx.getHandler(), ctx.getClass()]
    );
    // Undecorated routes are untouched, exactly like PermissionGuard.
    if (!options) return true;

    const req = ctx.switchToHttp().getRequest<AuthRequest & {
      ip?: string;
      method?: string;
      routerPath?: string;
      url?: string;
    }>();

    const now = Date.now();
    const bucketKey = `${req.method ?? "?"} ${req.routerPath ?? req.url ?? "?"}|${this.callerKey(req)}`;

    const decision = evaluateThrottle(
      this.buckets.get(bucketKey) ?? [],
      now,
      options
    );

    // Persist the aged-out window either way. On a rejection this is the
    // window UNCHANGED — a blocked request must not extend its own penalty.
    this.buckets.set(bucketKey, decision.hits);

    if (!decision.allowed) {
      const retryAfterSec = decision.retryAfterSec;

      const reply = ctx.switchToHttp().getResponse<{
        header?: (k: string, v: string | number) => unknown;
      }>();
      reply?.header?.("Retry-After", retryAfterSec);

      // Log it: a throttle firing on the admin surface is a security event,
      // and this line is the only place it will ever be visible.
      this.logger.warn(
        `Throttled ${bucketKey} — ${decision.hits.length} requests in ${options.windowMs}ms (limit ${options.limit}).`
      );

      throw new HttpException(
        `Too many requests. Try again in ${retryAfterSec} second${retryAfterSec === 1 ? "" : "s"}.`,
        HttpStatus.TOO_MANY_REQUESTS
      );
    }

    this.maybeSweep(now);
    return true;
  }

  /**
   * Who to count against.
   *
   * userId FIRST, and it is the one that matters. The global SupabaseAuthGuard
   * has already verified the token by the time a controller-bound guard runs,
   * so req.userId cannot be forged — whereas every IP below can be, because
   * the Railway origin is reachable without going through Cloudflare (see the
   * security audit: the origin URL ships in the client bundle). Keying on a
   * spoofable header alone would let an attacker reset their own bucket at
   * will by varying it.
   *
   * The IP fallback therefore only ever applies to unauthenticated traffic,
   * where it is better than nothing and no worse than the status quo.
   */
  private callerKey(req: AuthRequest & { ip?: string }): string {
    if (req.userId) return `user:${req.userId}`;

    const header = (name: string): string | undefined => {
      const raw = req.headers?.[name];
      const value = Array.isArray(raw) ? raw[0] : raw;
      return typeof value === "string" && value.trim() ? value.trim() : undefined;
    };

    // CF-Connecting-IP is set by Cloudflare and is the real client when the
    // request actually came through it. X-Forwarded-For's FIRST hop is the
    // originating client per RFC 7239 convention.
    const cf = header("cf-connecting-ip");
    const xff = header("x-forwarded-for")?.split(",")[0]?.trim();
    return `ip:${cf ?? xff ?? req.ip ?? "unknown"}`;
  }

  /** Drop buckets whose every timestamp has aged out. */
  private maybeSweep(now: number): void {
    if (++this.sinceSweep < SWEEP_EVERY_N_REQUESTS) return;
    this.sinceSweep = 0;
    // The widest window any caller configured; anything older is dead for all.
    const maxWindowMs = 60 * 60 * 1000;
    for (const [key, hits] of this.buckets) {
      if (hits.every((t) => now - t >= maxWindowMs)) this.buckets.delete(key);
    }
  }
}
