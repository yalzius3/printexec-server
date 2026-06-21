import { UnauthorizedException } from "@nestjs/common";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Single token-verification path shared by the guard and the auth controller.
// Supabase access tokens are JWTs. We verify them with the Auth client's
// getClaims():
//   - With ASYMMETRIC signing keys (ES256/RS256) it verifies the signature
//     LOCALLY against a JWKS that is fetched once and cached on the client
//     instance — so an authenticated request costs ZERO outbound Auth calls.
//   - While the project is still on the LEGACY HS256 shared secret, getClaims
//     falls back to a single Auth-server call (a shared secret can't be verified
//     locally). Rotating to asymmetric signing keys in the Supabase dashboard
//     (Project Settings → JWT Keys) flips this to fully local automatically,
//     with NO code change. This file is the single switch point.
// getClaims validates the `exp` claim by default, so expired tokens are rejected.
export interface VerifiedToken {
  userId: string;
  email: string;
}

// One verify-only client, lazily built and reused across calls so the JWKS it
// fetches for asymmetric verification is cached on the instance rather than
// re-fetched per request. No session is persisted — this client only verifies.
let client: SupabaseClient | null = null;

function getClient(url: string, anonKey: string): SupabaseClient {
  if (!client) {
    client = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  return client;
}

// Verify a raw bearer token (the part after "Bearer ") and return its identity.
// Fails closed: any verification problem throws UnauthorizedException.
export async function verifyToken(
  token: string,
  url: string,
  anonKey: string
): Promise<VerifiedToken> {
  const { data, error } = await getClient(url, anonKey).auth.getClaims(token);
  if (error || !data) {
    throw new UnauthorizedException(
      `Invalid or expired token: ${error?.message ?? "verification failed"}`
    );
  }

  // Supabase puts the user id in `sub` and the address in `email`.
  const claims = data.claims;
  const userId = typeof claims.sub === "string" ? claims.sub : "";
  const email = typeof claims.email === "string" ? claims.email : "";
  if (!userId) {
    throw new UnauthorizedException("Token missing subject claim.");
  }

  return { userId, email };
}
