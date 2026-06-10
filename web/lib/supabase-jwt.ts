/**
 * Supabase-compatible JWT minting (HS256) for the RLS activation path.
 *
 * ⚠️  NOT yet wired into the live auth path. This is the building block for the
 * migration described in docs/RLS_JWT_MIGRATION.md: on the Spotify OAuth
 * callback we mint a short-lived Supabase JWT carrying the user's UUID as
 * `sub`, store it in an httpOnly cookie, and switch `supabaseServer()` to use
 * the anon key + this bearer so Postgres RLS policies evaluate against
 * `auth.uid()`. Do not flip the live path to this without staging validation —
 * a wrong secret or claim shape locks every user out.
 *
 * Signs with the project's JWT secret (Supabase → Settings → API → JWT Secret),
 * exposed to the server only as SUPABASE_JWT_SECRET. Uses Node's crypto so no
 * dependency is added.
 */

import { createHmac, timingSafeEqual } from "crypto";

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export type SupabaseJwtClaims = {
  sub: string;
  role: string;
  aud: string;
  iat: number;
  exp: number;
};

/**
 * Mint a short-lived Supabase auth JWT for the given user UUID.
 *
 * @param userId  The user's Supabase UUID (becomes `sub`; `auth.uid()` in RLS).
 * @param secret  The project JWT secret (SUPABASE_JWT_SECRET).
 */
export function mintSupabaseJwt(
  userId: string,
  secret: string,
  opts: { expiresInSeconds?: number; role?: string } = {}
): string {
  if (!userId) throw new Error("mintSupabaseJwt: userId is required");
  if (!secret) throw new Error("mintSupabaseJwt: JWT secret is required");

  const expiresInSeconds = opts.expiresInSeconds ?? 3600;
  const role = opts.role ?? "authenticated";
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "HS256", typ: "JWT" };
  const payload: SupabaseJwtClaims = {
    sub: userId,
    role,
    aud: "authenticated",
    iat: now,
    exp: now + expiresInSeconds,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

/** Verify an HS256 JWT signature and expiry, returning its claims or null. */
export function verifySupabaseJwt(token: string, secret: string): SupabaseJwtClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encHeader, encPayload, encSig] = parts;

  const expected = createHmac("sha256", secret)
    .update(`${encHeader}.${encPayload}`)
    .digest("base64url");

  const a = Buffer.from(encSig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const claims = JSON.parse(Buffer.from(encPayload, "base64url").toString("utf8")) as SupabaseJwtClaims;
    if (typeof claims.exp === "number" && claims.exp < Math.floor(Date.now() / 1000)) {
      return null; // expired
    }
    return claims;
  } catch {
    return null;
  }
}
