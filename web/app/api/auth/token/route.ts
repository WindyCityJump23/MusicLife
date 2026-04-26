import { NextRequest, NextResponse } from "next/server";

// Refresh-or-return endpoint used by the Web Playback SDK's getOAuthToken
// callback. Returns the current access token, refreshing it via Spotify's
// refresh-token grant when the cached one is within REFRESH_BUFFER_MS of
// expiring. Tokens stay in HTTP-only cookies; the browser only sees the
// access token in the JSON response, never the refresh token.

const REFRESH_BUFFER_MS = 60_000;

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const access = req.cookies.get("sp_access")?.value;
  const expiresAt = Number(req.cookies.get("sp_access_expires_at")?.value) || 0;
  const refresh = req.cookies.get("sp_refresh")?.value;

  if (access && expiresAt - Date.now() > REFRESH_BUFFER_MS) {
    return NextResponse.json({ access_token: access, expires_at: expiresAt });
  }

  if (!refresh) {
    return NextResponse.json({ error: "no_refresh_token" }, { status: 401 });
  }

  const basic = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString("base64");

  const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
    }),
  });

  if (!tokenRes.ok) {
    return NextResponse.json({ error: "refresh_failed" }, { status: 401 });
  }

  const tokens = await tokenRes.json();
  const expiresIn = Number(tokens.expires_in) || 3600;
  const newExpiresAt = Date.now() + expiresIn * 1000;
  const cookieAge = Math.max(expiresIn - 60, 60);

  const res = NextResponse.json({
    access_token: tokens.access_token,
    expires_at: newExpiresAt,
  });

  const cookieOpts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
  };

  res.cookies.set("sp_access", tokens.access_token, { ...cookieOpts, maxAge: cookieAge });
  res.cookies.set("sp_access_expires_at", String(newExpiresAt), { ...cookieOpts, maxAge: cookieAge });

  // Spotify rotates refresh tokens occasionally — persist the new one when present.
  if (tokens.refresh_token) {
    res.cookies.set("sp_refresh", tokens.refresh_token, {
      ...cookieOpts,
      maxAge: 60 * 60 * 24 * 30,
    });
  }

  return res;
}
