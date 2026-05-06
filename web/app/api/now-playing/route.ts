import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";
import { applySpotifyTokenCookies, getSpotifyToken } from "@/lib/spotify-token";

export const dynamic = "force-dynamic";

/**
 * GET /api/now-playing
 *
 * Returns the user's current Spotify playback state — what's playing, where,
 * and whether it's paused. Used by the player to reflect actual device state
 * (e.g. user pressed pause on their phone, advanced tracks on a speaker).
 *
 * Spotify returns 204 No Content when nothing is playing; we normalize that
 * to { is_playing: false, item: null }.
 */
export async function GET(request: NextRequest) {
  const user = requireUser(request);
  if (isErrorResponse(user)) return user;

  const token = await getSpotifyToken(request);
  if (!token) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const accessToken = token.accessToken;

  const res = await fetch("https://api.spotify.com/v1/me/player", {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });

  if (res.status === 204) {
    return applySpotifyTokenCookies(
      NextResponse.json({
        is_playing: false,
        item: null,
        device: null,
        progress_ms: 0,
      }),
      token
    );
  }

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    return applySpotifyTokenCookies(
      NextResponse.json(
        { error: errBody?.error?.message ?? "Failed to fetch playback state" },
        { status: res.status }
      ),
      token
    );
  }

  const data = await res.json();
  return applySpotifyTokenCookies(
    NextResponse.json({
      is_playing: !!data.is_playing,
      progress_ms: data.progress_ms ?? 0,
      device: data.device
        ? {
            id: data.device.id,
            name: data.device.name,
            type: data.device.type,
          }
        : null,
      item: data.item
        ? {
            id: data.item.id,
            name: data.item.name,
            duration_ms: data.item.duration_ms,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            artists: (data.item.artists ?? []).map((a: any) => a.name),
            album: {
              name: data.item.album?.name ?? "",
              image: data.item.album?.images?.[0]?.url ?? null,
            },
          }
        : null,
    }),
    token
  );
}
