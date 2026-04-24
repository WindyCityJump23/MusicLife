import { NextRequest, NextResponse } from "next/server";

// Exchange the authorization code for access + refresh tokens.
// Stash tokens in HTTP-only cookies for now — a proper build would
// store the refresh token in Supabase keyed to the user row.
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const returnedState = req.nextUrl.searchParams.get("state");
  const storedState = req.cookies.get("sp_oauth_state")?.value;

  if (!code) {
    return NextResponse.redirect(new URL("/?error=no_code", req.url));
  }

  if (!returnedState || !storedState || returnedState !== storedState) {
    return NextResponse.redirect(new URL("/?error=state_mismatch", req.url));
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: process.env.SPOTIFY_REDIRECT_URI!,
  });

  const basic = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString("base64");

  const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body,
  });

  if (!tokenRes.ok) {
    return NextResponse.redirect(new URL("/?error=token_exchange", req.url));
  }

  const tokens = await tokenRes.json();
  // tokens: { access_token, token_type, expires_in, refresh_token, scope }

  const res = NextResponse.redirect(new URL("/dashboard", req.url));
  res.cookies.set("sp_oauth_state", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });

  res.cookies.set("sp_access", tokens.access_token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: Math.max((tokens.expires_in ?? 3600) - 60, 60),
    path: "/",
  });

  if (tokens.refresh_token) {
    res.cookies.set("sp_refresh", tokens.refresh_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 30,
      path: "/",
    });
  }

  return res;
}
