import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";
import { getSpotifyAccessToken } from "@/lib/spotify-token";

export const dynamic = "force-dynamic";

/**
 * GET /api/devices
 *
 * Lists the user's currently-online Spotify Connect devices (phone, desktop
 * app, speakers, etc.). Used by the Player to pick a target for playback so
 * the user can keep listening with their screen locked at the gym.
 *
 * A device only appears here if the corresponding Spotify app is open and
 * recently active. Killed apps don't show up — the user has to open Spotify
 * on the device once.
 */
export async function GET(request: NextRequest) {
  const user = requireUser(request);
  if (isErrorResponse(user)) return user;

  const accessToken = await getSpotifyAccessToken(request);
  if (!accessToken) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const res = await fetch("https://api.spotify.com/v1/me/player/devices", {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    return NextResponse.json(
      { error: errBody?.error?.message ?? "Failed to list devices" },
      { status: res.status }
    );
  }

  const data = await res.json();
  type Device = {
    id: string;
    name: string;
    type: string;
    is_active: boolean;
    is_restricted: boolean;
    volume_percent: number | null;
  };
  const devices: Device[] = (data.devices ?? []).map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (d: any): Device => ({
      id: d.id,
      name: d.name,
      type: d.type,
      is_active: !!d.is_active,
      is_restricted: !!d.is_restricted,
      volume_percent: d.volume_percent ?? null,
    })
  );

  return NextResponse.json({ devices });
}
