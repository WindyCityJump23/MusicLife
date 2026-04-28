import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";

function baseUrl(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? new URL(req.url).host;
  return `${proto}://${host}`;
}

function setCookieOpts(secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
  };
}

// Exchange the Spotify authorization code for tokens, upsert the user into
// Supabase, and store the user's Supabase UUID in a cookie so every route
// handler can identify them without an extra Spotify API call on each request.
export async function GET(req: NextRequest) {
  const secure = process.env.NODE_ENV === "production";
  const base = baseUrl(req);

  const code = req.nextUrl.searchParams.get("code");
  const returnedState = req.nextUrl.searchParams.get("state");
  const storedState = req.cookies.get("sp_oauth_state")?.value;

  if (!code) {
    return NextResponse.redirect(new URL("/?error=no_code", base));
  }
  if (!returnedState || !storedState || returnedState !== storedState) {
    return NextResponse.redirect(new URL("/?error=state_mismatch", base));
  }

  // ── Exchange code for tokens ───────────────────────────────────────────
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
      grant_type: "authorization_code",
      code,
      redirect_uri: process.env.SPOTIFY_REDIRECT_URI!,
    }),
  });

  if (!tokenRes.ok) {
    return NextResponse.redirect(new URL("/?error=token_exchange", base));
  }

  const tokens = await tokenRes.json();

  if (!tokens.access_token) {
    console.error("auth/callback: token exchange returned no access_token", JSON.stringify(tokens));
    return NextResponse.redirect(new URL("/?error=token_missing", base));
  }

  const expiresIn = Number(tokens.expires_in) || 3600;
  const cookieAge = Math.max(expiresIn - 60, 60);

  // ── Fetch Spotify profile ──────────────────────────────────────────────
  // cache: 'no-store' prevents Next.js from caching this response in the Data
  // Cache — a stale/error response cached from a previous request would
  // otherwise cause every subsequent login attempt to fail.
  const profileRes = await fetch("https://api.spotify.com/v1/me", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
    cache: "no-store",
  });

  if (!profileRes.ok) {
    const body = await profileRes.text().catch(() => "");
    console.error(`auth/callback: profile fetch failed ${profileRes.status}: ${body}`);
    // Surface the actual Spotify error to help debug
    const detail = profileRes.status === 403 ? "forbidden" : profileRes.status === 401 ? "token_invalid" : "profile_fetch";
    return NextResponse.redirect(new URL(`/?error=${detail}&spotify_status=${profileRes.status}`, base));
  }

  const profile = await profileRes.json();
  const spotifyId: string = profile.id;
  const displayName: string = profile.display_name ?? profile.id;

  // ── Upsert user into Supabase ──────────────────────────────────────────
  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false } });

  // Upsert the user row. The users.id column is a plain uuid (not auth.uid)
  // so we must supply one on insert. ON CONFLICT (spotify_user_id) DO UPDATE
  // leaves the existing id untouched, so the generated UUID is only used
  // when creating a brand-new row.
  // Try to find existing user first.
  const { data: existingUser } = await sb
    .from("users")
    .select("id")
    .eq("spotify_user_id", spotifyId)
    .maybeSingle();

  let supabaseUserId: string;

  if (existingUser) {
    // Returning user — use existing row and refresh display_name.
    supabaseUserId = existingUser.id;
    await sb
      .from("users")
      .update({ display_name: displayName })
      .eq("id", supabaseUserId);
  } else {
    // New user — insert with a fresh UUID.
    const newId = randomUUID();
    const { data: newUser, error: insertErr } = await sb
      .from("users")
      .insert({ id: newId, spotify_user_id: spotifyId, display_name: displayName })
      .select("id")
      .single();

    if (insertErr || !newUser) {
      console.error("auth/callback: user insert failed", insertErr?.message);
      return NextResponse.redirect(new URL("/?error=user_upsert", base));
    }
    supabaseUserId = newUser.id;
  }

  // ── Set cookies and redirect ───────────────────────────────────────────
  const res = NextResponse.redirect(new URL("/dashboard", base));

  // Clear CSRF state cookie
  res.cookies.set("sp_oauth_state", "", { ...setCookieOpts(secure), maxAge: 0 });

  // Spotify tokens
  res.cookies.set("sp_access", tokens.access_token, {
    ...setCookieOpts(secure),
    maxAge: cookieAge,
  });
  res.cookies.set("sp_access_expires_at", String(Date.now() + expiresIn * 1000), {
    ...setCookieOpts(secure),
    maxAge: cookieAge,
  });
  if (tokens.refresh_token) {
    res.cookies.set("sp_refresh", tokens.refresh_token, {
      ...setCookieOpts(secure),
      maxAge: 60 * 60 * 24 * 30,
    });
  }

  // User identity — stored in a long-lived cookie so route handlers don't
  // need to call Spotify /me on every request.
  res.cookies.set("app_user_id", supabaseUserId, {
    ...setCookieOpts(secure),
    maxAge: 60 * 60 * 24 * 30,
  });
  res.cookies.set("app_display_name", encodeURIComponent(displayName), {
    ...setCookieOpts(secure),
    maxAge: 60 * 60 * 24 * 30,
  });

  return res;
}
