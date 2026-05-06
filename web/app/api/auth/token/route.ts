import { NextRequest, NextResponse } from "next/server";
import { applySpotifyTokenCookies, getSpotifyToken } from "@/lib/spotify-token";

// Refresh-or-return endpoint used by the Web Playback SDK's getOAuthToken
// callback. Returns the current access token, refreshing it via Spotify's
// refresh-token grant when the cached one is near expiry. Tokens stay in
// HTTP-only cookies; the browser only sees the access token in the JSON
// response, never the refresh token.

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = await getSpotifyToken(req);
  if (!token) {
    return NextResponse.json({ error: "no_refresh_token" }, { status: 401 });
  }

  const res = NextResponse.json({
    access_token: token.accessToken,
    expires_at: token.expiresAt,
  });

  return applySpotifyTokenCookies(res, token);
}
