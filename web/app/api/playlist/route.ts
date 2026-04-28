import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * POST /api/playlist
 *
 * Creates a Spotify playlist from an array of artist names.
 * For each artist, fetches their top track on Spotify and adds it to the playlist.
 *
 * Body: {
 *   name?: string          — playlist name (default: "MusicLife Discover")
 *   description?: string   — playlist description
 *   artists: string[]      — list of artist names from recommendations
 *   isPublic?: boolean     — whether the playlist is public (default: false)
 * }
 *
 * Returns: { ok: true, playlist_url, playlist_id, tracks_added, tracks_failed }
 */
export async function POST(request: NextRequest) {
  const user = requireUser(request);
  if (isErrorResponse(user)) return user;

  // ── Parse body ─────────────────────────────────────────────
  let artists: string[] = [];
  let playlistName = "MusicLife Discover";
  let description = "Created by MusicLife — personalized music discovery";
  let isPublic = false;

  try {
    const body = await request.json();
    artists = body.artists;
    if (body.name) playlistName = body.name;
    if (body.description) description = body.description;
    if (typeof body.isPublic === "boolean") isPublic = body.isPublic;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!Array.isArray(artists) || artists.length === 0) {
    return NextResponse.json(
      { error: "artists array is required and must not be empty" },
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
    return NextResponse.json({ error: "Failed to get Spotify profile" }, { status: 502 });
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
    const msg = err?.error?.message ?? "Failed to create playlist";

    if (createRes.status === 403) {
      return NextResponse.json(
        {
          error:
            "Missing playlist permissions. Please sign out and sign back in to grant the new permissions.",
        },
        { status: 403 }
      );
    }

    return NextResponse.json({ error: msg }, { status: createRes.status });
  }

  const playlist = await createRes.json();
  const playlistId: string = playlist.id;
  const playlistUrl: string = playlist.external_urls?.spotify ?? "";

  // ── Resolve artist names → top track URIs ──────────────────
  const trackUris: string[] = [];
  const failed: string[] = [];

  // Process in batches of 5 to avoid rate limits
  for (let i = 0; i < artists.length; i += 5) {
    const batch = artists.slice(i, i + 5);

    const results = await Promise.all(
      batch.map(async (artistName) => {
        try {
          // Search for the artist
          const searchRes = await fetch(
            `https://api.spotify.com/v1/search?q=${encodeURIComponent(artistName)}&type=artist&limit=1`,
            { headers }
          );

          if (!searchRes.ok) return { artist: artistName, uri: null };

          const searchData = await searchRes.json();
          const found = searchData.artists?.items?.[0];
          if (!found) return { artist: artistName, uri: null };

          // Get top tracks
          const tracksRes = await fetch(
            `https://api.spotify.com/v1/artists/${found.id}/top-tracks?market=US`,
            { headers }
          );

          if (!tracksRes.ok) return { artist: artistName, uri: null };

          const tracksData = await tracksRes.json();
          const topTrack = tracksData.tracks?.[0];
          if (!topTrack) return { artist: artistName, uri: null };

          return { artist: artistName, uri: topTrack.uri as string };
        } catch {
          return { artist: artistName, uri: null };
        }
      })
    );

    for (const r of results) {
      if (r.uri) {
        trackUris.push(r.uri);
      } else {
        failed.push(r.artist);
      }
    }

    // Small delay between batches to respect rate limits
    if (i + 5 < artists.length) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  if (trackUris.length === 0) {
    // Delete the empty playlist we just created
    await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/followers`, {
      method: "DELETE",
      headers,
    }).catch(() => {});

    return NextResponse.json(
      { error: "Could not find any tracks on Spotify for the given artists" },
      { status: 404 }
    );
  }

  // ── Add tracks to the playlist (max 100 per request) ───────
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
      const err = await addRes.json().catch(() => ({}));
      return NextResponse.json(
        { error: err?.error?.message ?? "Failed to add tracks to playlist" },
        { status: addRes.status }
      );
    }
  }

  return NextResponse.json({
    ok: true,
    playlist_url: playlistUrl,
    playlist_id: playlistId,
    tracks_added: trackUris.length,
    tracks_failed: failed,
  });
}
