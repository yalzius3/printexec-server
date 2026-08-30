// ════════════════════════════════════════════════════════════════
// The sliding-window decision behind ThrottleGuard, kept as a PURE module.
//
// Separate file, no Nest imports, on purpose: Node's strip-only TypeScript
// loader (what `npm test` runs) cannot transform decorators or constructor
// parameter properties, so throttle.guard.ts itself can never be imported by a
// test. Extracting the arithmetic is what makes it testable at all — the same
// reason jobs/matching.ts exists apart from the services that call it.
//
// Covered by test/throttle-window.test.ts.
// ════════════════════════════════════════════════════════════════

export interface ThrottleWindowOptions {
  /** Requests permitted inside the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface ThrottleDecision {
  /** Whether this request may proceed. */
  allowed: boolean;
  /**
   * The caller's timestamps to persist. On an allowed request this includes
   * the current one; on a rejection it is the surviving window UNCHANGED — a
   * blocked request must not extend its own penalty, or a client that keeps
   * retrying can never recover.
   */
  hits: number[];
  /** Whole seconds until a slot frees up. Only meaningful when blocked. */
  retryAfterSec: number;
}

/**
 * Decide whether one request fits inside the caller's window.
 *
 * `previous` is the caller's recorded timestamps (any age — ageing out happens
 * here). `now` is injected rather than read from the clock so tests can drive
 * time explicitly.
 */
export function evaluateThrottle(
  previous: readonly number[],
  now: number,
  options: ThrottleWindowOptions
): ThrottleDecision {
  // A non-positive limit would otherwise block everything including the first
  // request, which is never what a caller means by "rate limit this".
  const limit = Math.max(1, Math.floor(options.limit));

  // Strictly-less-than: a hit exactly windowMs old has served its time.
  const live = previous.filter((t) => now - t < options.windowMs);

  if (live.length >= limit) {
    // The OLDEST live hit is the one whose expiry frees a slot.
    const freesAtMs = options.windowMs - (now - live[0]!);
    return {
      allowed: false,
      hits: live,
      // Round up, floor at 1: a sub-second wait must never advertise "0",
      // which clients read as "retry immediately".
      retryAfterSec: Math.max(1, Math.ceil(freesAtMs / 1000))
    };
  }

  return { allowed: true, hits: [...live, now], retryAfterSec: 0 };
}

// ── Caller identity ─────────────────────────────────────────────────────────

/** The subset of a request this needs. Kept structural so no Nest type leaks
 *  into a module that must stay importable by node --test. */
export interface ThrottleCallerInput {
  userId?: string;
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * Who to count a request against, or null when it cannot be told apart from
 * anyone else.
 *
 * userId FIRST and it is the one that matters: the global auth guard has
 * already verified the token by the time any controller-bound guard runs, so
 * it cannot be forged. Every IP below can be, because the Railway origin is
 * reachable without going through Cloudflare.
 *
 * Returning NULL is the important case. If a proxy header is present but
 * unusable, req.ip is the PROXY — an address shared by every caller on earth —
 * and keying on it would let strangers exhaust each other's budget. On a signup
 * path that is a self-inflicted outage, so the caller must fail open instead.
 */
export function resolveThrottleCaller(req: ThrottleCallerInput): string | null {
  if (req.userId) return `user:${req.userId}`;

  const header = (name: string): string | undefined => {
    const raw = req.headers?.[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };

  // CF-Connecting-IP is set by Cloudflare and is the real client when the
  // request genuinely came through it. X-Forwarded-For's FIRST hop is the
  // originating client by convention.
  const cf = header("cf-connecting-ip");
  const xff = header("x-forwarded-for")?.split(",")[0]?.trim();
  const chosen = cf ?? xff;
  if (chosen) return `ip:${chosen}`;

  // No proxy header at all means nothing is in front of us, so req.ip really is
  // the client (local dev, or a direct hit).
  //
  // Presence is tested on the RAW header, deliberately, not through header()
  // above — header() returns undefined for an empty or whitespace value, so
  // using it here could not tell "no proxy" from "a proxy that sent an empty
  // X-Forwarded-For". That collapse is the dangerous direction: it would fall
  // through to req.ip, which behind a proxy is an address every caller shares.
  const hasRawHeader = (name: string): boolean =>
    req.headers?.[name] !== undefined;
  const behindProxy = hasRawHeader("x-forwarded-for") || hasRawHeader("forwarded");
  if (!behindProxy && req.ip) return `ip:${req.ip}`;
  return null;
}
