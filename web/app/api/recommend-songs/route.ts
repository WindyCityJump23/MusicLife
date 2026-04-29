import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 25; // Vercel Pro allows up to 60s; free tier 10s

/**
 * POST /api/recommend-songs
 *
 * Hybrid song recommender:
 * 1. Calls the backend /recommend (artist-level) for scored artists
 * 2. For each top artist, fetches their top tracks from Spotify
 * 3. Returns songs ranked by artist_score × track_popularity
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

  // ── Step 1: Get artist recommendations (only 15 to keep fast) ──
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
      limit: 15,
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

  // ── Step 2: Get Spotify access token ───────────────────────
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
    // No Spotify token — return artist names as placeholder songs
    return NextResponse.json({ results: artists.map(artistToSongFallback) });
  }

  const spotifyHeaders = { Authorization: `Bearer ${accessToken}` };

  // ── Step 3: Fetch tracks via Search API (not top-tracks) ───
  // The artists/{id}/top-tracks endpoint returns 403 for Spotify apps
  // in Development Mode (restricted since Spotify's Nov 2024 API changes).
  // The Search API still works, so we search for tracks by each artist.
  const songArrays = await Promise.all(
    artists.map(async (artist): Promise<SongResult[]> => {
      try {
        const searchRes = await fetch(
          `https://api.spotify.com/v1/search?q=${encodeURIComponent(`artist:${artist.artist_name}`)}&type=track&market=US&limit=5`,
          { headers: spotifyHeaders }
        );
        if (!searchRes.ok) return [];

        const searchData = await searchRes.json();
        const tracks: SpotifyTrack[] = (searchData.tracks?.items ?? []).slice(0, 3);

        return tracks.map((track): SongResult => {
          const trackPop = (track.popularity ?? 50) / 100;
          const songScore = artist.score * (0.7 + 0.3 * trackPop);

          return {
            track_id: null,
            track_name: track.name,
            artist_id: artist.artist_id,
            artist_name: track.artists?.[0]?.name ?? artist.artist_name,
            album_name: track.album?.name ?? "",
            duration_ms: track.duration_ms ?? 0,
            explicit: track.explicit ?? false,
            spotify_track_id: track.id,
            score: Math.round(songScore * 10000) / 10000,
            signals: {
              affinity: artist.signals.affinity,
              context: artist.signals.context,
              editorial: artist.signals.editorial,
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

  const allSongs = songArrays.flat();

  // ── Step 4: Sort, deduplicate, cap per artist ──────────────
  allSongs.sort((a, b) => b.score - a.score);

  const seen = new Set<string>();
  const deduped: SongResult[] = [];
  const artistCounts: Record<string, number> = {};

  for (const song of allSongs) {
    const key = `${song.track_name.toLowerCase()}|${song.artist_name.toLowerCase()}`;
    if (seen.has(key)) continue;

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
  album?: { name: string };
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
