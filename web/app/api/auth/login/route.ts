import { randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Spotify OAuth — authorization code flow.
const SCOPES = [
  "user-read-email",
  "user-read-private",
  "user-library-read",
  "user-top-read",
  "user-read-recently-played",
  "user-read-playback-state",
  "user-modify-playback-state",
  "streaming",
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-public",
  "playlist-modify-private",
  "user-library-modify",
].join(" ");

// Cookies set by MusicLife that should be cleared on force-reconnect.
const APP_COOKIES = [
  "app_user_id",
  "app_display_name",
  "sp_access",
  "sp_access_expires_at",
  "sp_refresh",
  "sp_oauth_state",
];

export async function GET(req: NextRequest) {
  const force = req.nextUrl.searchParams.get("force") === "1";

  console.log(`[auth/login] start | force=${force}`);

  // ── Env var validation ─────────────────────────────────────
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const redirectUri = process.env.SPOTIFY_REDIRECT_URI;
  const missing: string[] = [];
  if (!clientId) missing.push("SPOTIFY_CLIENT_ID");
  if (!redirectUri) missing.push("SPOTIFY_REDIRECT_URI");

  if (missing.length > 0) {
    console.error(`[auth/login] misconfigured — missing: ${missing.join(", ")}`);
    return NextResponse.json(
      { error: "spotify_oauth_misconfigured", missing },
      { status: 500 }
    );
  }

  console.log(`[auth/login] env OK | redirectUri host=${new URL(redirectUri!).host}`);

  // ── Existing session shortcut (skip when force=1) ──────────
  if (!force) {
    const existingUserId = req.cookies.get("app_user_id")?.value;
    const existingAccess = req.cookies.get("sp_access")?.value;

    if (existingUserId && existingAccess) {
      console.log("[auth/login] existing session → /dashboard");
      return NextResponse.redirect(new URL("/dashboard", req.url));
    }
  }

  // ── Build Spotify authorize URL ────────────────────────────
  const state = randomBytes(16).toString("hex");
  const secure = process.env.NODE_ENV === "production";

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId!,
    scope: SCOPES,
    redirect_uri: redirectUri!,
    state,
  });

  // force=1: always show Spotify's consent dialog (bypasses cached grants)
  if (force) {
    params.set("show_dialog", "true");
  }

  const authorizeUrl = `https://accounts.spotify.com/authorize?${params.toString()}`;

  console.log(`[auth/login] redirecting to Spotify | show_dialog=${force}`);

  const res = NextResponse.redirect(authorizeUrl);

  // ── Clear stale cookies when force-reconnecting ────────────
  if (force) {
    for (const name of APP_COOKIES) {
      res.cookies.set(name, "", {
        httpOnly: true,
        secure,
        sameSite: "lax",
        path: "/",
        maxAge: 0,
      });
    }
  }

  // ── Set fresh OAuth state cookie ───────────────────────────
  res.cookies.set("sp_oauth_state", state, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    maxAge: 60 * 10,
    path: "/",
  });

  return res;
}
