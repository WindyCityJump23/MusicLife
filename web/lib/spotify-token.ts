/**
 * Server-side helper: get a valid Spotify access token, refreshing it directly
 * when needed so route handlers can forward rotated cookies to the browser.
 *
 * Returns the token string or null if the user isn't authenticated.
 */

import { NextRequest, NextResponse } from "next/server";

const REFRESH_BUFFER_MS = 60_000;

type SpotifyTokenResult = {
  accessToken: string;
  expiresAt: number;
  refreshed: boolean;
  refreshToken?: string;
  maxAge?: number;
};

function cookieOpts() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
  };
}

export async function getSpotifyAccessToken(
  request: NextRequest
): Promise<string | null> {
  const result = await getSpotifyToken(request);
  return result?.accessToken ?? null;
}

export async function getSpotifyToken(
  request: NextRequest
): Promise<SpotifyTokenResult | null> {
  const access = request.cookies.get("sp_access")?.value;
  const expiresAt = Number(request.cookies.get("sp_access_expires_at")?.value) || 0;
  const refresh = request.cookies.get("sp_refresh")?.value;

  if (access && expiresAt - Date.now() > REFRESH_BUFFER_MS) {
    return { accessToken: access, expiresAt, refreshed: false };
  }

  if (!refresh) return null;

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

  if (!tokenRes.ok) return null;

  const tokens = await tokenRes.json();
  if (typeof tokens.access_token !== "string") return null;

  const expiresIn = Number(tokens.expires_in) || 3600;
  return {
    accessToken: tokens.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
    refreshed: true,
    refreshToken:
      typeof tokens.refresh_token === "string" ? tokens.refresh_token : undefined,
    maxAge: Math.max(expiresIn - 60, 60),
  };
}

export function applySpotifyTokenCookies(
  response: NextResponse,
  token: SpotifyTokenResult | null
): NextResponse {
  if (!token?.refreshed || !token.maxAge) return response;

  const opts = cookieOpts();
  response.cookies.set("sp_access", token.accessToken, {
    ...opts,
    maxAge: token.maxAge,
  });
  response.cookies.set("sp_access_expires_at", String(token.expiresAt), {
    ...opts,
    maxAge: token.maxAge,
  });

  if (token.refreshToken) {
    response.cookies.set("sp_refresh", token.refreshToken, {
      ...opts,
      maxAge: 60 * 60 * 24 * 30,
    });
  }

  return response;
}
