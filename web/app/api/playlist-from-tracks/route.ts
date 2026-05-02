import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * POST /api/playlist-from-tracks
 *
 * Creates a Spotify playlist directly from track IDs — no searching required.
 * This is much faster and more accurate than the artist-based approach because
 * we already know the exact Spotify track IDs from our recommendation engine.
 *
 * Body: {
 *   track_ids: string[]      — Spotify track IDs (not URIs)
 *   name?: string             — playlist name
 *   description?: string      — playlist description
 *   isPublic?: boolean        — whether the playlist is public (default: false)
 * }
 *
 * Returns: { ok, playlist_url, playlist_id, tracks_added, tracks_failed }
 */
export async function POST(request: NextRequest) {
  const user = requireUser(request);
  if (isErrorResponse(user)) return user;

  // ── Parse body ─────────────────────────────────────────────
  let trackIds: string[] = [];
  let playlistName = "MusicLife Discover";
  let description = "Created by MusicLife — personalized music discovery";
  let isPublic = false;

  try {
    const body = await request.json();
    trackIds = body.track_ids;
    if (body.name) playlistName = body.name;
    if (body.description) description = body.description;
    if (typeof body.isPublic === "boolean") isPublic = body.isPublic;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!Array.isArray(trackIds) || trackIds.length === 0) {
    return NextResponse.json(
      { error: "track_ids array is required and must not be empty" },
      { status: 400 }
    );
  }

  // ── Get Spotify access token ───────────────────────────────
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

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };

  // ── Get Spotify user ID ────────────────────────────────────
  const meRes = await fetch("https://api.spotify.com/v1/me", { headers });
  if (!meRes.ok) {
    const meErr = await meRes.json().catch(() => ({}));
    console.error(`[playlist-from-tracks] /me failed HTTP ${meRes.status}:`, JSON.stringify(meErr));
    if (meRes.status === 401 || meRes.status === 403) {
      return NextResponse.json(
        { error: "Spotify session expired — please sign out and sign back in." },
        { status: 401 }
      );
    }
    return NextResponse.json(
      { error: `Failed to get Spotify profile (HTTP ${meRes.status})` },
      { status: 502 }
    );
  }
  const meData = await meRes.json();
  const spotifyUserId: string = meData.id;

  // ── Create the playlist ────────────────────────────────────
  const createRes = await fetch(
    `https://api.spotify.com/v1/users/${spotifyUserId}/playlists`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: playlistName,
        description,
        public: isPublic,
      }),
    }
  );

  if (!createRes.ok) {
    const err = await createRes.json().catch(() => ({}));
    const spotifyMsg = err?.error?.message ?? "";
    console.error(
      `[playlist-from-tracks] Spotify create failed HTTP ${createRes.status}:`,
      JSON.stringify(err)
    );

    if (createRes.status === 401) {
      return NextResponse.json(
        { error: "Spotify session expired — please sign out and sign back in." },
        { status: 401 }
      );
    }
    if (createRes.status === 403) {
      return NextResponse.json(
        { error: "Playlist permissions missing — please sign out and sign back in to grant access." },
        { status: 403 }
      );
    }

    return NextResponse.json(
      { error: spotifyMsg || `Spotify error (HTTP ${createRes.status})` },
      { status: createRes.status }
    );
  }

  const playlist = await createRes.json();
  const playlistId: string = playlist.id;
  const playlistUrl: string = playlist.external_urls?.spotify ?? "";

  // ── Build track URIs directly from IDs ─────────────────────
  const validTrackIds = trackIds.filter(
    (id) => typeof id === "string" && id.length > 0
  );
  const trackUris = validTrackIds.map((id) =>
    id.startsWith("spotify:track:") ? id : `spotify:track:${id}`
  );

  if (trackUris.length === 0) {
    // Delete the empty playlist
    await fetch(
      `https://api.spotify.com/v1/playlists/${playlistId}/followers`,
      { method: "DELETE", headers }
    ).catch(() => {});

    return NextResponse.json(
      { error: "No valid track IDs provided" },
      { status: 400 }
    );
  }

  // ── Add tracks to the playlist (max 100 per request) ───────
  const failed: string[] = [];
  for (let i = 0; i < trackUris.length; i += 100) {
    const batch = trackUris.slice(i, i + 100);
    const addRes = await fetch(
      `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ uris: batch }),
      }
    );

    if (!addRes.ok) {
      // Some tracks might have invalid IDs — try one by one
      for (const uri of batch) {
        const singleRes = await fetch(
          `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ uris: [uri] }),
          }
        );
        if (!singleRes.ok) {
          failed.push(uri.replace("spotify:track:", ""));
        }
      }
    }
  }

  const tracksAdded = trackUris.length - failed.length;

  return NextResponse.json({
    ok: true,
    playlist_url: playlistUrl,
    playlist_id: playlistId,
    playlist_name: playlistName,
    tracks_added: tracksAdded,
    tracks_failed: failed,
  });
}
