// Single source of truth for the CURRENT Terms of Use version.
//
// Bump this (date-stamped) whenever the terms text changes materially:
// every member's stored users.tos_version stops matching, /auth/me flags
// the mismatch, and the client shows its re-accept interstitial before the
// workspace. New signups always record this version at /auth/setup.
//
// The terms TEXT lives client-side (printexec-client/src/TermsOfUse.tsx),
// which carries its own copy of this string — the repos are separate, so
// keep the two in lockstep when bumping.
export const TERMS_VERSION = "2026-07-25";
