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
