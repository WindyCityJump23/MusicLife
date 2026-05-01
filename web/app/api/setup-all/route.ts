import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const user = requireUser(req);
  if (isErrorResponse(user)) return user;

  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  if (!apiUrl) {
    return NextResponse.json({ error: "NEXT_PUBLIC_API_URL not configured" }, { status: 500 });
  }

  const tokenRes = await fetch(
    new URL("/api/auth/token", req.url).toString(),
    { headers: { cookie: req.headers.get("cookie") ?? "" }, cache: "no-store" }
  );
  if (!tokenRes.ok) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  const { access_token: accessToken } = await tokenRes.json();
  if (!accessToken) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY not configured" }, { status: 500 });
  }

  // Pass the refresh token + client credentials so the API can self-refresh
  // the Spotify token before step 5 (populate-tracks). Steps 1–4 can take
  // longer than the access token's 1-hour validity for large libraries.
  const refreshToken = req.cookies.get("sp_refresh")?.value ?? "";
  const spotifyClientId = process.env.SPOTIFY_CLIENT_ID ?? "";
  const spotifyClientSecret = process.env.SPOTIFY_CLIENT_SECRET ?? "";

  const upstream = await fetch(`${apiUrl}/ingest/setup-all`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify({
      user_id: user.userId,
      spotify_access_token: accessToken,
      spotify_refresh_token: refreshToken || undefined,
      spotify_client_id: spotifyClientId || undefined,
      spotify_client_secret: spotifyClientSecret || undefined,
    }),
  });

  const data = await upstream.json().catch(() => ({}));
  return NextResponse.json(data, { status: upstream.status });
}
