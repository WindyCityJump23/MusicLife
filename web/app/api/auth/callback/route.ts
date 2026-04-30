import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Hard cap: total time spent retrying inside this request must stay under this.
const MAX_TOTAL_RETRY_MS = 6000;
const MAX_RETRY_ATTEMPTS = 2; // Only retry for 5xx/network, never for 429

function baseUrl(req: NextRequest): string {
  const proto =
    req.headers.get("x-forwarded-proto") ??
    new URL(req.url).protocol.replace(":", "");
  const host =
    req.headers.get("x-forwarded-host") ?? new URL(req.url).host;
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
// Supabase, and store the user's Supabase UUID in a cookie.
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

  // ── Exchange code for tokens ───────────────────────────────
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
    console.error(
      `[auth/callback] token exchange failed: ${tokenRes.status}`
    );
    return NextResponse.redirect(
      new URL(
        `/?error=token_exchange&spotify_status=${tokenRes.status}`,
        base
      )
    );
  }

  const tokens = await tokenRes.json();

  if (!tokens.access_token) {
    console.error("[auth/callback] token exchange returned no access_token");
    return NextResponse.redirect(new URL("/?error=token_missing", base));
  }

  const expiresIn = Number(tokens.expires_in) || 3600;
  const cookieAge = Math.max(expiresIn - 60, 60);

  // ── Fetch Spotify profile ──────────────────────────────────
  // CRITICAL: Never sleep for Spotify's Retry-After value inside a
  // serverless function. 429 → redirect immediately. Only retry 5xx.
  let profileRes: Response | null = null;
  let totalWaited = 0;

  for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      profileRes = await fetch("https://api.spotify.com/v1/me", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
        cache: "no-store",
      });

      // ── 429: Rate limited — redirect immediately, never wait ──
      if (profileRes.status === 429) {
        const retryAfter = profileRes.headers.get("retry-after");
        const retrySeconds = retryAfter ? Number(retryAfter) : null;

        console.warn(
          `[auth/callback] Spotify 429 rate limited | retry-after=${retryAfter}s | redirecting immediately (not waiting)`
        );

        const query = new URLSearchParams({
          error: "rate_limited",
          spotify_status: "429",
        });
        if (retrySeconds && Number.isFinite(retrySeconds)) {
          query.set("retry_after", String(Math.ceil(retrySeconds)));
        }
        return NextResponse.redirect(new URL(`/?${query}`, base));
      }

      // ── Success
      if (profileRes.ok) break;

      // ── 4xx (non-429): deterministic failure, don't retry ──
      if (profileRes.status < 500) {
        console.error(
          `[auth/callback] Spotify profile ${profileRes.status}`
        );
        break;
      }

      // ── 5xx: transient, retry with short backoff ──
      if (attempt < MAX_RETRY_ATTEMPTS) {
        const waitMs = Math.min(1000 * (attempt + 1), MAX_TOTAL_RETRY_MS - totalWaited);
        if (waitMs > 0) {
          console.warn(
            `[auth/callback] Spotify 5xx (${profileRes.status}), retry ${attempt + 1}/${MAX_RETRY_ATTEMPTS} in ${waitMs}ms`
          );
          await new Promise((r) => setTimeout(r, waitMs));
          totalWaited += waitMs;
        }
      }
    } catch (err) {
      console.error(`[auth/callback] profile fetch network error`, err);
      profileRes = null;

      if (attempt < MAX_RETRY_ATTEMPTS) {
        const waitMs = Math.min(1000 * (attempt + 1), MAX_TOTAL_RETRY_MS - totalWaited);
        if (waitMs > 0) {
          await new Promise((r) => setTimeout(r, waitMs));
          totalWaited += waitMs;
        }
      }
    }
  }

  if (!profileRes || !profileRes.ok) {
    const status = profileRes?.status ?? "network";
    const body = profileRes ? await profileRes.text().catch(() => "") : "";
    console.error(
      `[auth/callback] profile fetch failed: ${status} | body=${body}`
    );

    const detail =
      profileRes?.status === 403
        ? "forbidden"
        : profileRes?.status === 401
          ? "token_invalid"
          : "profile_fetch";
    return NextResponse.redirect(
      new URL(`/?error=${detail}&spotify_status=${status}`, base)
    );
  }

  const profile = await profileRes.json();
  const spotifyId: string = profile.id;
  const displayName: string = profile.display_name ?? profile.id;

  // ── Upsert user into Supabase ──────────────────────────────
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
      .insert({
        id: newId,
        spotify_user_id: spotifyId,
        display_name: displayName,
      })
      .select("id")
      .single();

    if (insertErr || !newUser) {
      console.error(
        "[auth/callback] user insert failed",
        insertErr?.message
      );
      return NextResponse.redirect(new URL("/?error=user_upsert", base));
    }
    supabaseUserId = newUser.id;
  }

  // ── Set cookies and redirect to dashboard ──────────────────
  const res = NextResponse.redirect(new URL("/dashboard", base));

  // Clear CSRF state
  res.cookies.set("sp_oauth_state", "", {
    ...setCookieOpts(secure),
    maxAge: 0,
  });

  // Spotify tokens
  res.cookies.set("sp_access", tokens.access_token, {
    ...setCookieOpts(secure),
    maxAge: cookieAge,
  });
  res.cookies.set(
    "sp_access_expires_at",
    String(Date.now() + expiresIn * 1000),
    { ...setCookieOpts(secure), maxAge: cookieAge }
  );
  if (tokens.refresh_token) {
    res.cookies.set("sp_refresh", tokens.refresh_token, {
      ...setCookieOpts(secure),
      maxAge: 60 * 60 * 24 * 30,
    });
  }

  // User identity
  res.cookies.set("app_user_id", supabaseUserId, {
    ...setCookieOpts(secure),
    maxAge: 60 * 60 * 24 * 30,
  });
  res.cookies.set("app_display_name", encodeURIComponent(displayName), {
    ...setCookieOpts(secure),
    maxAge: 60 * 60 * 24 * 30,
  });

  console.log(
    `[auth/callback] success | user=${supabaseUserId} | spotify=${spotifyId}`
  );
  return res;
}
