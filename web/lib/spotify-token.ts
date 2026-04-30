/**
 * Server-side helper: get a valid Spotify access token by calling our own
 * /api/auth/token route, which transparently refreshes when needed.
 *
 * Returns the token string or null if the user isn't authenticated.
 */

import { NextRequest } from "next/server";

export async function getSpotifyAccessToken(
  request: NextRequest
): Promise<string | null> {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const tokenRes = await fetch(`${request.nextUrl.origin}/api/auth/token`, {
    headers: { cookie: cookieHeader },
    cache: "no-store",
  });
  if (!tokenRes.ok) return null;
  const data = await tokenRes.json().catch(() => ({}));
  return typeof data.access_token === "string" ? data.access_token : null;
}
