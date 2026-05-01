import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * POST /api/populate-tracks
 *
 * Triggers the backend to populate the tracks table for all artists
 * using Spotify Search API. This fills in track data needed by the
 * DB-based song recommendation engine.
 */
export async function POST(req: NextRequest) {
  const user = requireUser(req);
  if (isErrorResponse(user)) return user;

  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  if (!apiUrl) {
    return NextResponse.json({ error: "NEXT_PUBLIC_API_URL not configured" }, { status: 500 });
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY not configured" }, { status: 500 });
  }

  // Get a fresh Spotify token for the backend to use
  let accessToken = req.cookies.get("sp_access")?.value ?? "";
  if (!accessToken) {
    const refresh = req.cookies.get("sp_refresh")?.value;
    if (refresh && process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
      const basic = Buffer.from(
        `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
      ).toString("base64");
      const refreshRes = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${basic}`,
        },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }),
      });
      if (refreshRes.ok) {
        const tokens = await refreshRes.json();
        accessToken = tokens.access_token ?? "";
      }
    }
  }

  if (!accessToken) {
    return NextResponse.json(
      { error: "Spotify session expired — please sign out and back in" },
      { status: 401 }
    );
  }

  const upstream = await fetch(`${apiUrl}/ingest/populate-tracks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify({
      spotify_access_token: accessToken,
      spotify_refresh_token: req.cookies.get("sp_refresh")?.value ?? undefined,
      spotify_client_id: process.env.SPOTIFY_CLIENT_ID ?? undefined,
      spotify_client_secret: process.env.SPOTIFY_CLIENT_SECRET ?? undefined,
    }),
  });

  const data = await upstream.json().catch(() => ({}));
  return NextResponse.json(data, { status: upstream.status });
}
