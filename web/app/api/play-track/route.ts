import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";
import { getSpotifyAccessToken } from "@/lib/spotify-token";

export const dynamic = "force-dynamic";

/**
 * POST /api/play-track
 *
 * Start playback on a Spotify Connect device. Two modes:
 *  - Single track: { spotify_track_id, device_id? }
 *  - Queue:        { uris: string[], offset_position?: number, device_id? }
 *
 * The queue mode is preferred — it hands the full list to Spotify so the
 * device auto-advances natively (works perfectly with the screen locked).
 */
export async function POST(request: NextRequest) {
  const user = requireUser(request);
  if (isErrorResponse(user)) return user;

  let spotifyTrackId: string | undefined;
  let urisInput: unknown;
  let offsetPosition: number | undefined;
  let deviceId: string | undefined;

  try {
    const body = await request.json();
    spotifyTrackId = body.spotify_track_id;
    urisInput = body.uris;
    offsetPosition =
      typeof body.offset_position === "number" ? body.offset_position : undefined;
    deviceId = body.device_id;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  // Build the URI list — either from `uris` or a single `spotify_track_id`.
  let uris: string[] = [];
  if (Array.isArray(urisInput)) {
    uris = urisInput
      .filter((u): u is string => typeof u === "string" && u.length > 0)
      .map((u) => (u.startsWith("spotify:track:") ? u : `spotify:track:${u}`));
  } else if (typeof spotifyTrackId === "string" && spotifyTrackId.length > 0) {
    uris = [
      spotifyTrackId.startsWith("spotify:track:")
        ? spotifyTrackId
        : `spotify:track:${spotifyTrackId}`,
    ];
  }

  if (uris.length === 0) {
    return NextResponse.json(
      { error: "spotify_track_id or uris is required" },
      { status: 400 }
    );
  }

  // Spotify caps `uris` at 100 per request.
  if (uris.length > 100) uris = uris.slice(0, 100);

  const accessToken = await getSpotifyAccessToken(request);
  if (!accessToken) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let playUrl = "https://api.spotify.com/v1/me/player/play";
  if (deviceId && typeof deviceId === "string") {
    playUrl += `?device_id=${encodeURIComponent(deviceId)}`;
  }

  const playBody: { uris: string[]; offset?: { position: number } } = { uris };
  if (
    typeof offsetPosition === "number" &&
    offsetPosition >= 0 &&
    offsetPosition < uris.length
  ) {
    playBody.offset = { position: offsetPosition };
  }

  const playRes = await fetch(playUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(playBody),
  });

  if (!playRes.ok && playRes.status !== 204 && playRes.status !== 202) {
    const errBody = await playRes.json().catch(() => ({}));
    const errorMsg = errBody?.error?.message ?? "Failed to start playback";
    const reason = errBody?.error?.reason;

    if (reason === "NO_ACTIVE_DEVICE" || playRes.status === 404) {
      return NextResponse.json(
        {
          error:
            "No active Spotify device. Open Spotify on your phone, then pick it from the device list.",
          reason: "NO_ACTIVE_DEVICE",
        },
        { status: 404 }
      );
    }

    if (playRes.status === 403 || reason === "PREMIUM_REQUIRED") {
      return NextResponse.json(
        {
          error: "Spotify Premium required for remote playback.",
          reason: "PREMIUM_REQUIRED",
        },
        { status: 403 }
      );
    }

    return NextResponse.json({ error: errorMsg }, { status: playRes.status });
  }

  return NextResponse.json({ ok: true, count: uris.length });
}
