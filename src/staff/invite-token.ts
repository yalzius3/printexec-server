// ════════════════════════════════════════════════════════════════
// INVITE TOKEN KERNEL — how a staff invite code is minted, and how a code
// someone typed is folded back onto the one stored in company_invites.
//
// Extracted from staff.service.ts for the same two reasons as jobs/matching.ts:
//
//   1. The mint and the match have to agree, forever. They used to sit at
//      opposite ends of the codebase — generateToken() in staff.service.ts,
//      a bare `WHERE token = $1` in auth.controller.ts — and they did NOT
//      agree: generation emits a hyphen, redemption folded nothing, so a
//      correct code entered without the hyphen (or with an en-dash pasted out
//      of an email) was answered "This invite code doesn't exist". One module
//      owns both halves so the format can only ever be defined once.
//
//   2. staff.service.ts declares a Nest service with constructor parameter
//      properties — syntax Node's strip-only TypeScript loader refuses — so a
//      test importing from it dies with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX
//      before a single assertion runs. Pure module, no decorators, directly
//      testable.
//
// staff.service.ts re-exports both functions, so existing import sites are
// untouched.
//
// Covered by test/invite-token.test.ts.
// ════════════════════════════════════════════════════════════════

import { randomInt } from "node:crypto";

// Deliberately excludes I, O, 0 and 1 — the four glyphs people most often
// transcribe as each other. Note it still contains both halves of 2/Z, 5/S,
// 8/B and 6/G; those are a known readability weakness, not an oversight, and
// they are NOT folded during canonicalization (see below).
export const INVITE_CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Length of the code proper, excluding the group separator. */
const BODY_LENGTH = 8;
/** The separator sits after this many characters: ABCD-EFGH. */
const GROUP_SIZE = 4;

/**
 * Everything a paste or a keyboard can put between the two groups, or invisibly
 * alongside them. Hoisted to module scope: it is applied on every keystroke on
 * the client mirror of this function, and rebuilding a RegExp per call is pure
 * waste.
 *
 *   \s                    ascii whitespace
 *   _ \-                  underscore, ascii hyphen
 *   \u00a0               no-break space (survives a copy out of rendered HTML)
 *   \u200b-\u200f        zero-width space/non-joiner/joiner, LRM, RLM —
 *                        invisible, NOT matched by \s, and routinely carried
 *                        along when a code is copied out of an email body or
 *                        an RTL message
 *   \u2010-\u2015        hyphen, non-breaking hyphen, figure/en/em dash,
 *                        horizontal bar — what smart punctuation and PDFs
 *                        substitute for a plain -
 *   \u2028 \u2029         line + paragraph separator
 *   \u2060               word joiner
 *   \u2212               minus sign
 *   \ufeff               zero-width no-break space / BOM
 */
const SEPARATORS =
  /[\s_\-\u00a0\u200b-\u200f\u2010-\u2015\u2028\u2029\u2060\u2212\ufeff]/gu;

/**
 * Mint a new invite code in canonical form: ABCD-EFGH.
 *
 * Uses crypto.randomInt, not Math.random. Math.random is a seeded xorshift128+
 * whose internal state is recoverable from a run of observed outputs — and
 * anyone who has legitimately been invited once has observed an output.
 */
export function generateInviteToken(): string {
  let t = "";
  for (let i = 0; i < BODY_LENGTH; i++) {
    if (i === GROUP_SIZE) t += "-";
    t += INVITE_CHARSET[randomInt(INVITE_CHARSET.length)];
  }
  return t;
}

/**
 * Fold whatever a person typed or pasted onto the canonical stored form, or
 * return "" if it cannot be one.
 *
 * FAILS CLOSED, and that is the whole point: this only ever strips separators
 * and normalizes case. It never folds one code character into another — no
 * O→0, no 5→S — because the alphabet contains both halves of several
 * look-alike pairs, and folding them would map two DIFFERENT live invite codes
 * onto the same lookup key. A canonicalizer that can widen the match set is a
 * way to walk into someone else's workspace. Stripping separators cannot
 * collide, because no separator is a member of INVITE_CHARSET.
 *
 * The empty string is the only "no" this returns; the caller decides the
 * status code, so the copy stays in one place.
 */
export function canonicalizeInviteToken(raw: string): string {
  const body = raw.toUpperCase().replace(SEPARATORS, "");
  if (body.length !== BODY_LENGTH) return "";
  for (const ch of body) {
    if (!INVITE_CHARSET.includes(ch)) return "";
  }
  return `${body.slice(0, GROUP_SIZE)}-${body.slice(GROUP_SIZE)}`;
}
