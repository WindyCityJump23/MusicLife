import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * POST /api/recommend-songs
 *
 * Hybrid song recommender:
 * 1. Calls the backend /recommend (artist-level) for scored artists
 * 2. For each top artist, fetches their top tracks from Spotify
 * 3. Returns songs ranked by artist_score × track_popularity
 *
 * This ensures we recommend songs the user DOESN'T already have,
 * because Spotify's top tracks endpoint returns globally popular
 * tracks, not just what's in our DB.
 */
export async function POST(req: NextRequest) {
  const user = requireUser(req);
  if (isErrorResponse(user)) return user;

  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  if (!apiUrl) {
    return NextResponse.json({ error: "NEXT_PUBLIC_API_URL not configured" }, { status: 500 });
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY not configured" }, { status: 500 });
  }

  const body = await req.json().catch(() => ({}));
  const songLimit = body.limit ?? 30;

  // ── Step 1: Get artist-level recommendations from backend ──
  const artistRes = await fetch(`${apiUrl}/recommend`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify({
      user_id: user.userId,
      prompt: body.prompt ?? null,
      weights: body.weights ?? { affinity: 0.4, context: 0.4, editorial: 0.2 },
      exclude_library: true,
      limit: Math.min(songLimit, 30), // Get enough artists
    }),
  });

  const artistData = await artistRes.json().catch(() => ({}));
  if (!artistRes.ok) {
    return NextResponse.json(artistData, { status: artistRes.status });
  }

  const artists: ArtistRec[] = artistData.results ?? [];
  if (artists.length === 0) {
    return NextResponse.json({ results: [] });
  }

  // ── Step 2: Get Spotify access token from cookies ──────────
  // Read directly instead of calling /api/auth/token (avoids internal fetch issues)
  let accessToken = req.cookies.get("sp_access")?.value ?? "";

  if (!accessToken) {
    const refresh = req.cookies.get("sp_refresh")?.value;
    if (refresh && process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
      try {
        const basic = Buffer.from(
          `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
        ).toString("base64");
        const refreshRes = await fetch("https://accounts.spotify.com/api/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${basic}`,
          },
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }),
        });
        if (refreshRes.ok) {
          const tokens = await refreshRes.json();
          accessToken = tokens.access_token ?? "";
        }
      } catch {}
    }
  }

  if (!accessToken) {
    return NextResponse.json({ results: artists.map(artistToSongFallback) });
  }

  const spotifyHeaders = { Authorization: `Bearer ${accessToken}` };

  // ── Step 3: Fetch top tracks for each artist from Spotify ──
  // Process in batches of 5 to respect rate limits
  const allSongs: SongResult[] = [];

  for (let i = 0; i < artists.length; i += 5) {
    const batch = artists.slice(i, i + 5);

    const results = await Promise.all(
      batch.map(async (artist) => {
        try {
          // Search Spotify for the artist
          const searchRes = await fetch(
            `https://api.spotify.com/v1/search?q=${encodeURIComponent(artist.artist_name)}&type=artist&limit=1`,
            { headers: spotifyHeaders }
          );
          if (!searchRes.ok) return [];

          const searchData = await searchRes.json();
          const spotifyArtist = searchData.artists?.items?.[0];
          if (!spotifyArtist) return [];

          // Get their top tracks
          const tracksRes = await fetch(
            `https://api.spotify.com/v1/artists/${spotifyArtist.id}/top-tracks?market=US`,
            { headers: spotifyHeaders }
          );
          if (!tracksRes.ok) return [];

          const tracksData = await tracksRes.json();
          const tracks: SpotifyTrack[] = (tracksData.tracks ?? []).slice(0, 3);

          return tracks.map((track): SongResult => {
            const trackPop = (track.popularity ?? 50) / 100;
            const artistScore = artist.score;
            // Final score: artist recommendation score × track popularity boost
            const songScore = artistScore * (0.7 + 0.3 * trackPop);

            return {
              track_id: null,
              track_name: track.name,
              artist_id: artist.artist_id,
              artist_name: artist.artist_name,
              album_name: track.album?.name ?? "",
              duration_ms: track.duration_ms ?? 0,
              explicit: track.explicit ?? false,
              spotify_track_id: track.id,
              score: Math.round(songScore * 10000) / 10000,
              signals: {
                ...artist.signals,
                track_popularity: Math.round(trackPop * 10000) / 10000,
                audio_match: 0,
              },
              genres: artist.genres ?? [],
              reasons: [...artist.reasons],
              mention_count: artist.mention_count ?? 0,
              top_mention: artist.top_mention ?? null,
            };
          });
        } catch {
          return [];
        }
      })
    );

    for (const songs of results) {
      allSongs.push(...songs);
    }

    // Small delay between batches
    if (i + 5 < artists.length) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // ── Step 4: Sort by score, deduplicate, limit ──────────────
  allSongs.sort((a, b) => b.score - a.score);

  // Deduplicate by track name + artist (case insensitive)
  const seen = new Set<string>();
  const deduped: SongResult[] = [];
  const artistCounts: Record<string, number> = {};

  for (const song of allSongs) {
    const key = `${song.track_name.toLowerCase()}|${song.artist_name.toLowerCase()}`;
    if (seen.has(key)) continue;

    // Max 2 songs per artist
    const artistKey = song.artist_name.toLowerCase();
    if ((artistCounts[artistKey] ?? 0) >= 2) continue;

    seen.add(key);
    artistCounts[artistKey] = (artistCounts[artistKey] ?? 0) + 1;
    deduped.push(song);

    if (deduped.length >= songLimit) break;
  }

  return NextResponse.json({ results: deduped });
}

// ── Types ────────────────────────────────────────────────────────

type ArtistRec = {
  artist_id: string;
  artist_name: string;
  score: number;
  signals: { affinity: number; context: number; editorial: number };
  reasons: string[];
  genres: string[];
  mention_count: number;
  top_mention: { source: string; excerpt: string; published_at: string } | null;
};

type SpotifyTrack = {
  id: string;
  name: string;
  popularity: number;
  duration_ms: number;
  explicit: boolean;
  album?: { name: string; images?: Array<{ url: string }> };
  artists?: Array<{ name: string }>;
};

type SongResult = {
  track_id: string | null;
  track_name: string;
  artist_id: string;
  artist_name: string;
  album_name: string;
  duration_ms: number;
  explicit: boolean;
  spotify_track_id: string;
  score: number;
  signals: Record<string, number>;
  genres: string[];
  reasons: string[];
  mention_count: number;
  top_mention: { source: string; excerpt: string; published_at: string } | null;
};

/** Fallback: convert artist rec to song-shaped result when Spotify is unavailable */
function artistToSongFallback(artist: ArtistRec): SongResult {
  return {
    track_id: null,
    track_name: `Top track by ${artist.artist_name}`,
    artist_id: artist.artist_id,
    artist_name: artist.artist_name,
    album_name: "",
    duration_ms: 0,
    explicit: false,
    spotify_track_id: "",
    score: artist.score,
    signals: { ...artist.signals, track_popularity: 0, audio_match: 0 },
    genres: artist.genres,
    reasons: artist.reasons,
    mention_count: artist.mention_count,
    top_mention: artist.top_mention,
  };
}
