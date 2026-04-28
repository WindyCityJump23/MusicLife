import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";

/**
 * POST /api/play-track
 *
 * Play a specific Spotify track by its track ID or URI on the Web Playback SDK.
 * Much more direct than play-artist — no searching required.
 *
 * Body: { spotify_track_id: string, device_id?: string }
 */
export async function POST(request: NextRequest) {
  const user = requireUser(request);
  if (isErrorResponse(user)) return user;

  let spotifyTrackId: string | undefined;
  let deviceId: string | undefined;

  try {
    const body = await request.json();
    spotifyTrackId = body.spotify_track_id;
    deviceId = body.device_id;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!spotifyTrackId || typeof spotifyTrackId !== "string") {
    return NextResponse.json(
      { error: "spotify_track_id is required" },
      { status: 400 }
    );
  }

  // Get Spotify access token
  const cookieHeader = request.headers.get("cookie") ?? "";
  const tokenRes = await fetch(`${request.nextUrl.origin}/api/auth/token`, {
    headers: { cookie: cookieHeader },
    cache: "no-store",
  });

  if (!tokenRes.ok) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const tokenData = await tokenRes.json();
  const accessToken: string = tokenData.access_token;
  if (!accessToken) {
    return NextResponse.json({ error: "No access token" }, { status: 401 });
  }

  // Build the track URI
  const trackUri = spotifyTrackId.startsWith("spotify:track:")
    ? spotifyTrackId
    : `spotify:track:${spotifyTrackId}`;

  // Start playback
  let playUrl = "https://api.spotify.com/v1/me/player/play";
  if (deviceId && typeof deviceId === "string") {
    playUrl += `?device_id=${encodeURIComponent(deviceId)}`;
  }

  const playRes = await fetch(playUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ uris: [trackUri] }),
  });

  if (!playRes.ok && playRes.status !== 204 && playRes.status !== 202) {
    const errBody = await playRes.json().catch(() => ({}));
    const errorMsg = errBody?.error?.message ?? "Failed to start playback";
    const reason = errBody?.error?.reason;

    if (reason === "NO_ACTIVE_DEVICE" || playRes.status === 404) {
      return NextResponse.json(
        {
          error:
            'No active player — click "Transfer to this tab" in the player panel first',
        },
        { status: 404 }
      );
    }

    if (playRes.status === 403 || reason === "PREMIUM_REQUIRED") {
      return NextResponse.json(
        {
          error:
            "Spotify Premium required for in-browser playback.",
        },
        { status: 403 }
      );
    }

    return NextResponse.json({ error: errorMsg }, { status: playRes.status });
  }

  return NextResponse.json({ ok: true, uri: trackUri });
}
