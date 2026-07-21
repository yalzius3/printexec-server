// ════════════════════════════════════════════════════════════════
// CANONICAL APP ORIGIN FOR EMAIL
//
// Every link we put in an outbound email — CTA buttons, "open your workspace",
// the company logo at /api/uploads/logo/:companyId — resolves through here.
//
// WHY THIS EXISTS (and why it does NOT read ALLOWED_ORIGIN):
// emails used to build links from PUBLIC_APP_URL || ALLOWED_ORIGIN. Those vars
// legitimately hold whatever origin the API is currently serving CORS for —
// including pinned Cloudflare preview deployments like
// https://267e5fdb.printexec-client.pages.dev. A preview hash is fine for CORS
// and useless in an email: it is not the address customers should ever see,
// and it goes stale the moment a new preview is built. Emails are permanent
// and public-facing, so they get ONE stable, deliberate origin instead.
//
// Override only with EMAIL_APP_URL (an explicit "this is our public app
// address" decision). Anything else falls back to the production domain.
// ════════════════════════════════════════════════════════════════

/** The public app origin, e.g. https://solution.printexec.xyz (no trailing slash). */
export const DEFAULT_APP_URL = "https://solution.printexec.xyz";

/**
 * Canonical origin for links in emails. Deliberately ignores ALLOWED_ORIGIN /
 * PUBLIC_APP_URL so a preview-deployment origin can never leak into customer
 * mail; set EMAIL_APP_URL to move it.
 */
export function emailAppUrl(): string {
  const configured = (process.env.EMAIL_APP_URL ?? "").split(",")[0]?.trim() ?? "";
  const origin = configured.length > 0 ? configured : DEFAULT_APP_URL;
  return origin.replace(/\/+$/, "");
}
