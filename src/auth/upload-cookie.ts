import * as crypto from "crypto";

// Name of the HttpOnly cookie that authorizes same-origin GETs of guarded
// uploads. Browser <img>/<iframe>/<a download> and the STL viewer's fetch
// cannot attach an Authorization: Bearer header, so the uploads serve route is
// gated by this signed cookie instead. The cookie is (re)issued by
// POST /api/auth/session whenever the client has a live Supabase session.
export const UPLOAD_COOKIE_NAME = "xyz_upload_session";

// 7 days. The client re-issues on every session change (login + token refresh),
// so the cookie effectively tracks the auth session.
export const UPLOAD_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

interface UploadClaims {
  cid: string; // company_id
  exp: number; // unix seconds
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function hmac(secret: string, data: string): Buffer {
  return crypto.createHmac("sha256", secret).update(data).digest();
}

/** Sign a company-scoped upload session token: "<payload>.<sig>". */
export function signUploadCookie(secret: string, companyId: string): string {
  const claims: UploadClaims = {
    cid: companyId,
    exp: Math.floor(Date.now() / 1000) + UPLOAD_COOKIE_MAX_AGE_SECONDS,
  };
  const payload = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
  const sig = b64url(hmac(secret, payload));
  return `${payload}.${sig}`;
}

/** Verify the token's signature + expiry. Returns the companyId or null. */
export function verifyUploadCookie(secret: string, token: string): string | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = b64url(hmac(secret, payload));
  // Constant-time compare to avoid leaking the signature via timing.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let claims: UploadClaims;
  try {
    claims = JSON.parse(b64urlDecode(payload).toString("utf8")) as UploadClaims;
  } catch {
    return null;
  }
  if (typeof claims.cid !== "string" || typeof claims.exp !== "number") return null;
  if (claims.exp < Math.floor(Date.now() / 1000)) return null;
  return claims.cid;
}

/** Pull a single cookie value out of a raw Cookie header. */
export function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

/** Build the Set-Cookie header value for the upload session cookie. */
export function buildUploadCookieHeader(token: string, secure: boolean): string {
  const attrs = [
    `${UPLOAD_COOKIE_NAME}=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${UPLOAD_COOKIE_MAX_AGE_SECONDS}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}
