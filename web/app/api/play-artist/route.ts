import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";

export async function POST(request: NextRequest) {
  const user = requireUser(request);
  if (isErrorResponse(user)) return user;

  // Parse request body
  let artist_name: string | undefined;
  let device_id: string | undefined;
  try {
    const body = await request.json();
    artist_name = body.artist_name;
    device_id = body.device_id;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!artist_name || typeof artist_name !== "string") {
    return NextResponse.json({ error: "artist_name is required" }, { status: 400 });
  }

  // Get Spotify access token (forward session cookies via request headers)
  const cookieHeader = request.headers.get("cookie") ?? "";

  const tokenRes = await fetch(
    `${request.nextUrl.origin}/api/auth/token`,
    {
      headers: { cookie: cookieHeader },
      cache: "no-store",
    }
  );

  if (!tokenRes.ok) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const tokenData = await tokenRes.json();
  const access_token: string = tokenData.access_token;
  if (!access_token) {
    return NextResponse.json({ error: "No access token" }, { status: 401 });
  }

  // Search Spotify for the artist
  const searchRes = await fetch(
    `https://api.spotify.com/v1/search?q=${encodeURIComponent(artist_name)}&type=artist&limit=1`,
    { headers: { Authorization: `Bearer ${access_token}` } }
  );

  if (!searchRes.ok) {
    const errBody = await searchRes.json().catch(() => ({}));
    return NextResponse.json(
      { error: errBody?.error?.message ?? "Spotify search failed" },
      { status: 502 }
    );
  }

  const searchData = await searchRes.json();
  const artists: Array<{ id: string; name: string }> =
    searchData.artists?.items ?? [];

  if (artists.length === 0) {
    return NextResponse.json(
      { error: `Artist "${artist_name}" not found on Spotify` },
      { status: 404 }
    );
  }

  const spotifyArtist = artists[0];

  // Get top tracks
  const tracksRes = await fetch(
    `https://api.spotify.com/v1/artists/${spotifyArtist.id}/top-tracks?market=US`,
    { headers: { Authorization: `Bearer ${access_token}` } }
  );

  if (!tracksRes.ok) {
    const errBody = await tracksRes.json().catch(() => ({}));
    return NextResponse.json(
      { error: errBody?.error?.message ?? "Failed to get top tracks" },
      { status: 502 }
    );
  }

  const tracksData = await tracksRes.json();
  const tracks: Array<{ uri: string; name: string }> = (tracksData.tracks ?? []).slice(0, 5);
  const uris = tracks.map((t) => t.uri);

  if (uris.length === 0) {
    return NextResponse.json(
      { error: `No tracks found for "${artist_name}"` },
      { status: 404 }
    );
  }

  // Build playback URL — include device_id as query param if provided so
  // Spotify targets the Web Playback SDK player instead of whatever was
  // last active (phone, desktop app, etc.)
  let playUrl = "https://api.spotify.com/v1/me/player/play";
  if (device_id && typeof device_id === "string") {
    playUrl += `?device_id=${encodeURIComponent(device_id)}`;
  }

  const playRes = await fetch(playUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ uris }),
  });

  // 204 = success with no content; 202 = accepted
  if (!playRes.ok && playRes.status !== 204 && playRes.status !== 202) {
    const errBody = await playRes.json().catch(() => ({}));
    const errorMsg = errBody?.error?.message ?? "Failed to start playback";
    const reason = errBody?.error?.reason;

    // Provide helpful messages for the most common failures
    if (reason === "NO_ACTIVE_DEVICE" || playRes.status === 404) {
      return NextResponse.json(
        { error: "No active player \u2014 click \"Transfer to this tab\" in the player panel first" },
        { status: 404 }
      );
    }

    if (playRes.status === 403 || reason === "PREMIUM_REQUIRED") {
      return NextResponse.json(
        { error: "Spotify Premium required for in-browser playback. Open the artist in your Spotify app instead." },
        { status: 403 }
      );
    }

    return NextResponse.json(
      { error: errorMsg },
      { status: playRes.status }
    );
  }

  return NextResponse.json({
    ok: true,
    artist: spotifyArtist.name,
    tracks: tracks.map((t) => t.name),
    uris,
  });
}
