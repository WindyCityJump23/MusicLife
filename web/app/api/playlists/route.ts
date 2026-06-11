import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * GET /api/playlists
 *
 * Returns the user's Spotify playlists that were created by MusicLife
 * (identified by name prefix "MusicLife"). Each playlist includes its tracks
 * with album art, duration, and Spotify links.
 *
 * Query params:
 *   limit?: number  — max playlists to return (default 20)
 */
export async function GET(request: NextRequest) {
  const user = requireUser(request);
  if (isErrorResponse(user)) return user;

  const limit = Math.min(
    Number(request.nextUrl.searchParams.get("limit") ?? "20"),
    50
  );

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

  const headers = { Authorization: `Bearer ${accessToken}` };

  // ── Fetch user's playlists ─────────────────────────────────
  // Spotify paginates at 50 max per request. We fetch up to 100 to find
  // enough MusicLife ones (most users won't have that many).
  const allPlaylists: SpotifyPlaylist[] = [];
  let nextUrl: string | null =
    "https://api.spotify.com/v1/me/playlists?limit=50";

  while (nextUrl && allPlaylists.length < 200) {
    const res: Response = await fetch(nextUrl, { headers });
    if (!res.ok) break;
    const data: { items?: SpotifyPlaylist[]; next: string | null } =
      await res.json();
    const items: SpotifyPlaylist[] = data.items ?? [];
    allPlaylists.push(...items);
    nextUrl = data.next;
  }

  // Filter to MusicLife playlists
  const musicLifePlaylists = allPlaylists
    .filter((p) => p.name.startsWith("MusicLife"))
    .slice(0, limit);

  if (musicLifePlaylists.length === 0) {
    return NextResponse.json({ playlists: [] });
  }

  // ── Fetch tracks for each playlist ─────────────────────────
  // No `fields=` projection: Spotify's mid-2026 playlist API change returns
  // empty objects for the old `items(track(...))` paths. Fetch full pages and
  // normalize — newer responses nest the track under `item` instead of
  // `track` (where `track` is now a boolean discriminator on the item).
  const playlistsWithTracks = await Promise.all(
    musicLifePlaylists.map(async (pl) => {
      try {
        const tracksRes = await fetch(
          `https://api.spotify.com/v1/playlists/${pl.id}/items?limit=100`,
          { headers }
        );

        if (!tracksRes.ok) {
          return { ...formatPlaylist(pl), tracks: [] };
        }

        const tracksData = await tracksRes.json();
        const total: number | undefined =
          typeof tracksData.total === "number" ? tracksData.total : undefined;
        const tracks = (tracksData.items ?? [])
          .map((entry: { track?: unknown; item?: unknown }) =>
            entry.track && typeof entry.track === "object"
              ? (entry.track as SpotifyTrack)
              : entry.item && typeof entry.item === "object"
              ? (entry.item as SpotifyTrack)
              : null
          )
          .filter((track: SpotifyTrack | null): track is SpotifyTrack => Boolean(track))
          .map((track: SpotifyTrack) => ({
            name: track.name,
            artist: track.artists
              ?.map((a: { name: string }) => a.name)
              .join(", ") ?? "",
            album: track.album?.name ?? "",
            album_art:
              track.album?.images?.[track.album.images.length > 1 ? 1 : 0]
                ?.url ?? null,
            duration_ms: track.duration_ms ?? 0,
            spotify_url: track.external_urls?.spotify ?? "",
            uri: track.uri,
          }));

        return { ...formatPlaylist(pl, total ?? tracks.length), tracks };
      } catch {
        return { ...formatPlaylist(pl), tracks: [] };
      }
    })
  );

  return NextResponse.json({ playlists: playlistsWithTracks });
}

// ── Types ────────────────────────────────────────────────────────

type SpotifyPlaylist = {
  id: string;
  name: string;
  description: string | null;
  external_urls: { spotify: string };
  images: Array<{ url: string }>;
  tracks: { total: number };
  owner: { display_name: string };
};

type SpotifyTrack = {
  name: string;
  uri: string;
  duration_ms: number;
  artists: Array<{ name: string }>;
  album: {
    name: string;
    images: Array<{ url: string }>;
  };
  external_urls: { spotify: string };
};

function formatPlaylist(pl: SpotifyPlaylist, totalOverride?: number) {
  return {
    id: pl.id,
    name: pl.name,
    description: pl.description ?? "",
    spotify_url: pl.external_urls?.spotify ?? "",
    image: pl.images?.[0]?.url ?? null,
    // pl.tracks is gone from newer playlist payloads; prefer the items page total.
    track_count: totalOverride ?? pl.tracks?.total ?? 0,
  };
}
