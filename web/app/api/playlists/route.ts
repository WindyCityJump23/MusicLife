import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";

export const dynamic = "force-dynamic";

// Per-user in-memory cache of the playlist payload. Spotify quotas are tight
// in Development mode, and the user's playlists rarely change between
// dashboard navigations within a minute. Each /api/playlists hit otherwise
// fans out into ~20 concurrent Spotify calls.
type CacheEntry = { expires: number; payload: unknown };
const PLAYLIST_CACHE_TTL_MS = 60_000;
const playlistCache = new Map<string, CacheEntry>();

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
  const bypassCache = request.nextUrl.searchParams.get("refresh") === "1";

  // ── Cache check ────────────────────────────────────────────
  const cacheKey = `${user.userId}:${limit}`;
  if (!bypassCache) {
    const hit = playlistCache.get(cacheKey);
    if (hit && hit.expires > Date.now()) {
      return NextResponse.json(hit.payload);
    }
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
  const playlistsWithTracks = await Promise.all(
    musicLifePlaylists.map(async (pl) => {
      try {
        const tracksRes = await fetch(
          `https://api.spotify.com/v1/playlists/${pl.id}/tracks?limit=100&fields=items(track(name,uri,duration_ms,artists(name),album(name,images),external_urls))`,
          { headers }
        );

        if (!tracksRes.ok) {
          return { ...formatPlaylist(pl), tracks: [] };
        }

        const tracksData = await tracksRes.json();
        const tracks = (tracksData.items ?? [])
          .filter((item: { track: unknown }) => item.track)
          .map((item: { track: SpotifyTrack }) => ({
            name: item.track.name,
            artist: item.track.artists
              ?.map((a: { name: string }) => a.name)
              .join(", ") ?? "",
            album: item.track.album?.name ?? "",
            album_art:
              item.track.album?.images?.[item.track.album.images.length > 1 ? 1 : 0]
                ?.url ?? null,
            duration_ms: item.track.duration_ms ?? 0,
            spotify_url: item.track.external_urls?.spotify ?? "",
            uri: item.track.uri,
          }));

        return { ...formatPlaylist(pl), tracks };
      } catch {
        return { ...formatPlaylist(pl), tracks: [] };
      }
    })
  );

  const payload = { playlists: playlistsWithTracks };
  playlistCache.set(cacheKey, {
    expires: Date.now() + PLAYLIST_CACHE_TTL_MS,
    payload,
  });
  return NextResponse.json(payload);
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

function formatPlaylist(pl: SpotifyPlaylist) {
  return {
    id: pl.id,
    name: pl.name,
    description: pl.description ?? "",
    spotify_url: pl.external_urls?.spotify ?? "",
    image: pl.images?.[0]?.url ?? null,
    track_count: pl.tracks?.total ?? 0,
  };
}
