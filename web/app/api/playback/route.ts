import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";
import { getSpotifyAccessToken } from "@/lib/spotify-token";

export const dynamic = "force-dynamic";

type Action = "pause" | "resume" | "next" | "previous" | "transfer";

const ACTION_TO_REQUEST: Record<
  Exclude<Action, "transfer">,
  { method: "PUT" | "POST"; path: string }
> = {
  pause: { method: "PUT", path: "/me/player/pause" },
  resume: { method: "PUT", path: "/me/player/play" },
  next: { method: "POST", path: "/me/player/next" },
  previous: { method: "POST", path: "/me/player/previous" },
};

/**
 * POST /api/playback
 *
 * Spotify Connect remote-control actions. Lets the web app drive playback on
 * the user's chosen device (phone, desktop app, speaker, etc.) so audio keeps
 * going when the screen locks.
 *
 * Body: { action: "pause"|"resume"|"next"|"previous"|"transfer", device_id?: string }
 *  - "transfer" moves the active player to device_id (required for transfer).
 */
export async function POST(request: NextRequest) {
  const user = requireUser(request);
  if (isErrorResponse(user)) return user;

  let action: Action | undefined;
  let deviceId: string | undefined;
  try {
    const body = await request.json();
    action = body.action;
    deviceId = body.device_id;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!action) {
    return NextResponse.json({ error: "action is required" }, { status: 400 });
  }

  const accessToken = await getSpotifyAccessToken(request);
  if (!accessToken) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Transfer playback to a specific device (e.g. when user picks their phone).
  if (action === "transfer") {
    if (!deviceId) {
      return NextResponse.json(
        { error: "device_id is required for transfer" },
        { status: 400 }
      );
    }
    const res = await fetch("https://api.spotify.com/v1/me/player", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ device_ids: [deviceId], play: true }),
    });
    if (!res.ok && res.status !== 204) {
      const errBody = await res.json().catch(() => ({}));
      return NextResponse.json(
        { error: errBody?.error?.message ?? "Failed to transfer playback" },
        { status: res.status }
      );
    }
    return NextResponse.json({ ok: true });
  }

  const spec = ACTION_TO_REQUEST[action];
  if (!spec) {
    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }

  let url = `https://api.spotify.com${spec.path}`;
  if (deviceId) url += `?device_id=${encodeURIComponent(deviceId)}`;

  const res = await fetch(url, {
    method: spec.method,
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok && res.status !== 204) {
    const errBody = await res.json().catch(() => ({}));
    const reason = errBody?.error?.reason;
    if (reason === "NO_ACTIVE_DEVICE" || res.status === 404) {
      return NextResponse.json(
        { error: "No active Spotify device. Open Spotify on your phone or pick a device." },
        { status: 404 }
      );
    }
    if (res.status === 403 || reason === "PREMIUM_REQUIRED") {
      return NextResponse.json(
        { error: "Spotify Premium required for remote playback control." },
        { status: 403 }
      );
    }
    return NextResponse.json(
      { error: errBody?.error?.message ?? `Failed: ${action}` },
      { status: res.status }
    );
  }

  return NextResponse.json({ ok: true });
}
