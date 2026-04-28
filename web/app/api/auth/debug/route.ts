import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/auth/debug
 *
 * Temporary diagnostic endpoint. Returns safe booleans about OAuth config.
 * Does NOT expose actual env var values or secrets.
 *
 * TODO: Remove before production launch.
 */
export async function GET() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const redirectUri = process.env.SPOTIFY_REDIRECT_URI;

  let redirectUriHost: string | null = null;
  try {
    if (redirectUri) redirectUriHost = new URL(redirectUri).host;
  } catch {}

  return NextResponse.json({
    ok: true,
    hasSpotifyClientId: !!clientId,
    hasSpotifyClientSecret: !!clientSecret,
    hasSpotifyRedirectUri: !!redirectUri,
    redirectUriHost,
    nodeEnv: process.env.NODE_ENV ?? "unknown",
  });
}
