import { createClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";

const PROFILE_CACHE_COOKIE = "sp_profile_cache";
const PROFILE_CACHE_TOKEN_HASH_COOKIE = "sp_profile_token_hash";
const PROFILE_CACHE_MAX_AGE = 60 * 60 * 24; // 24h
const MAX_PROFILE_ATTEMPTS = 3;

type CachedProfile = {
  id: string;
  display_name?: string;
};

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

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function readCachedProfile(req: NextRequest, accessToken: string): CachedProfile | null {
  const cached = req.cookies.get(PROFILE_CACHE_COOKIE)?.value;
  const hash = req.cookies.get(PROFILE_CACHE_TOKEN_HASH_COOKIE)?.value;
  if (!cached || !hash || hash !== tokenHash(accessToken)) {
    return null;
  }

  try {
    const parsed = JSON.parse(decodeURIComponent(cached)) as CachedProfile;
    if (!parsed.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

function computeBackoffMs(attempt: number, retryAfterSeconds: number | null): number {
  if (retryAfterSeconds !== null && Number.isFinite(retryAfterSeconds)) {
    return Math.max(0, retryAfterSeconds) * 1000;
  }
  const base = 1000 * 2 ** attempt;
  const jitter = Math.floor(Math.random() * 350);
  return base + jitter;
}

async function fetchSpotifyProfile(accessToken: string): Promise<{ response: Response; retryAfterSeconds: number | null }> {
  const response = await fetch("https://api.spotify.com/v1/me", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "User-Agent": "MusicLife/1.0",
    },
    cache: "no-store",
  });

  const retryAfterHeader = response.headers.get("retry-after");
  const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : null;
  return { response, retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null };
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
    const tokenBody = await tokenRes.text().catch(() => "");
    console.error(`auth/callback: token exchange failed ${tokenRes.status}: ${tokenBody}`);
    return NextResponse.redirect(new URL(`/?error=token_exchange&spotify_status=${tokenRes.status}`, base));
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
  let profileRes: Response | null = null;
  let retryAfterSeconds: number | null = null;
  let lastErr: unknown = null;
  const cachedProfile = readCachedProfile(req, tokens.access_token);

  for (let attempt = 0; attempt < MAX_PROFILE_ATTEMPTS; attempt++) {
    try {
      const result = await fetchSpotifyProfile(tokens.access_token);
      const currentRes = result.response;
      profileRes = currentRes;
      retryAfterSeconds = result.retryAfterSeconds;

      if (currentRes.ok) break;

      if (currentRes.status === 429) {
        const waitMs = computeBackoffMs(attempt, retryAfterSeconds);
        console.warn(
          `auth/callback: Spotify profile rate limited (429), attempt ${attempt + 1}/${MAX_PROFILE_ATTEMPTS}, waiting ${waitMs}ms`
        );
        if (attempt < MAX_PROFILE_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, waitMs));
        }
        continue;
      }

      if (currentRes.status === 401 || currentRes.status === 403) {
        console.warn(`auth/callback: Spotify profile fetch denied with ${currentRes.status}`);
      }

      // Deterministic non-429 4xx failures should not be retried.
      if (currentRes.status < 500) break;

      // 5xx fallback with exponential backoff.
      const waitMs = computeBackoffMs(attempt, null);
      console.warn(
        `auth/callback: Spotify profile server error ${currentRes.status}, attempt ${attempt + 1}/${MAX_PROFILE_ATTEMPTS}, waiting ${waitMs}ms`
      );
      if (attempt < MAX_PROFILE_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, waitMs));
      }
    } catch (e) {
      lastErr = e;
      profileRes = null;
      const waitMs = computeBackoffMs(attempt, null);
      console.warn(`auth/callback: Spotify profile fetch network error on attempt ${attempt + 1}/${MAX_PROFILE_ATTEMPTS}; waiting ${waitMs}ms`);
      if (attempt < MAX_PROFILE_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }

  if (!profileRes) {
    console.error("auth/callback: profile fetch network error", lastErr);
    return NextResponse.redirect(new URL("/?error=profile_fetch&spotify_status=network", base));
  }

  let spotifyId: string;
  let displayName: string;

  if (!profileRes.ok) {
    const body = await profileRes.text().catch(() => "");
    console.error(`auth/callback: profile fetch failed ${profileRes.status}: ${body}`);

    // If rate-limited but we already have a cached profile for this token,
    // continue login without another /v1/me call.
    if (profileRes.status === 429 && cachedProfile) {
      spotifyId = cachedProfile.id;
      displayName = cachedProfile.display_name ?? cachedProfile.id;
      console.warn("auth/callback: using cached Spotify profile after 429 rate limit");
    } else {
      const detail =
        profileRes.status === 429
          ? "rate_limited"
          : profileRes.status === 403
            ? "forbidden"
            : profileRes.status === 401
              ? "token_invalid"
              : "profile_fetch";
      const query = new URLSearchParams({ error: detail, spotify_status: String(profileRes.status) });
      if (profileRes.status === 429 && retryAfterSeconds !== null) {
        query.set("retry_after", String(Math.ceil(retryAfterSeconds)));
      }
      return NextResponse.redirect(new URL(`/?${query.toString()}`, base));
    }
  } else {
    const profile = (await profileRes.json()) as CachedProfile;
    spotifyId = profile.id;
    displayName = profile.display_name ?? profile.id;
  }

  // ── Upsert user into Supabase ──────────────────────────────────────────
  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false } });

  const { data: existingUser } = await sb
    .from("users")
    .select("id")
    .eq("spotify_user_id", spotifyId)
    .maybeSingle();

  let supabaseUserId: string;

  if (existingUser) {
    supabaseUserId = existingUser.id;
    await sb
      .from("users")
      .update({ display_name: displayName })
      .eq("id", supabaseUserId);
  } else {
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

  // Cache Spotify profile for this access token to avoid repeated /v1/me calls
  // if the callback is retried and Spotify rate-limits.
  res.cookies.set(PROFILE_CACHE_COOKIE, encodeURIComponent(JSON.stringify({ id: spotifyId, display_name: displayName })), {
    ...setCookieOpts(secure),
    maxAge: PROFILE_CACHE_MAX_AGE,
  });
  res.cookies.set(PROFILE_CACHE_TOKEN_HASH_COOKIE, tokenHash(tokens.access_token), {
    ...setCookieOpts(secure),
    maxAge: PROFILE_CACHE_MAX_AGE,
  });

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
