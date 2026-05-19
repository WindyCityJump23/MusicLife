import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";
import { applySpotifyTokenCookies, getSpotifyToken } from "@/lib/spotify-token";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

type SpotifyTrack = {
  id?: string;
  name?: string;
  popularity?: number;
  duration_ms?: number;
  explicit?: boolean;
  album?: {
    name?: string;
    release_date?: string;
  };
  artists?: Array<{
    id?: string;
    name?: string;
  }>;
};

type SpotifyArtist = {
  id?: string;
  name?: string;
};

type LiveIntent = {
  query: string;
  label: string;
  reason: string;
};

const TRACK_LIMIT = 12;
const TRACKS_PER_INTENT = 5;
const DEFAULT_LIMIT = 40;
const SPOTIFY_FETCH_TIMEOUT_MS = 8_000;

function releaseFreshness(releaseDate: string | null | undefined): number {
  if (!releaseDate) return 0.35;
  const year = Number.parseInt(releaseDate.slice(0, 4), 10);
  if (!Number.isFinite(year)) return 0.35;
  const age = Math.max(new Date().getFullYear() - year, 0);
  if (age <= 1) return 1;
  if (age <= 3) return 0.75;
  if (age <= 6) return 0.5;
  return 0.25;
}

function laneFromPopularity(popularity: number): "deep_cuts" | "popular" | "radio_hits" {
  if (popularity < 0.46) return "deep_cuts";
  if (popularity >= 0.74) return "radio_hits";
  return "popular";
}

function scoreTrack(track: SpotifyTrack, intentIndex: number, trackIndex: number): number {
  const popularity = Math.max(0, Math.min(1, (track.popularity ?? 50) / 100));
  const rankScore = 1 - Math.min(trackIndex, TRACK_LIMIT - 1) / TRACK_LIMIT;
  const intentScore = 1 - Math.min(intentIndex, 6) / 7;
  const freshness = releaseFreshness(track.album?.release_date);
  const popularityShape = popularity > 0.78 ? -0.04 : popularity < 0.35 ? 0.07 : 0.04;

  return Number(
    Math.max(
      0.05,
      Math.min(0.92, 0.48 + rankScore * 0.16 + intentScore * 0.08 + freshness * 0.08 + popularityShape)
    ).toFixed(4)
  );
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  return values
    .map((value) => value.trim())
    .filter((value) => {
      const key = value.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function promptSearchVariants(prompt: string): string[] {
  const withoutBand = prompt.replace(/\bband\b/gi, "").replace(/\s+/g, " ").trim();
  return uniqueStrings([
    prompt,
    `"${prompt}"`,
    `artist:"${prompt}"`,
    withoutBand,
    withoutBand ? `artist:"${withoutBand}"` : "",
  ]);
}

function spotifySearchUrl(query: string, type: "artist" | "track", limit: number, withMarket: boolean): string {
  const params = new URLSearchParams({
    q: query,
    type,
    limit: String(limit),
  });
  if (withMarket) params.set("market", "US");
  return `https://api.spotify.com/v1/search?${params.toString()}`;
}

function chooseFallbackTracks(tracks: SpotifyTrack[]): SpotifyTrack[] {
  const seen = new Set<string>();
  const unique = tracks.filter((track) => {
    const key = `${track?.name ?? ""}|${track?.artists?.[0]?.name ?? ""}`.toLowerCase();
    if (!key.trim() || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (unique.length <= TRACKS_PER_INTENT) return unique;
  const sorted = [...unique].sort((a, b) => (a.popularity ?? 50) - (b.popularity ?? 50));
  const step = (sorted.length - 1) / (TRACKS_PER_INTENT - 1);
  return Array.from({ length: TRACKS_PER_INTENT }, (_, index) => sorted[Math.round(index * step)]);
}

function trackToRecommendation(
  track: SpotifyTrack,
  intent: LiveIntent,
  intentIndex: number,
  trackIndex: number
) {
  const artist = track.artists?.[0];
  if (!track.id || !track.name || !artist?.name) return null;

  const popularity = Math.max(0, Math.min(1, (track.popularity ?? 50) / 100));
  const freshness = releaseFreshness(track.album?.release_date);
  const novelty = Math.max(0.25, Math.min(1, 1 - popularity * 0.55 + freshness * 0.25));
  const score = scoreTrack(track, intentIndex, trackIndex);

  return {
    track_id: null,
    track_name: track.name,
    artist_id: `live:${artist.id ?? artist.name}`,
    artist_name: artist.name,
    album_name: track.album?.name ?? "",
    release_date: track.album?.release_date ?? null,
    duration_ms: track.duration_ms ?? 0,
    explicit: track.explicit ?? false,
    spotify_track_id: track.id,
    score,
    lane: laneFromPopularity(popularity),
    novelty_score: novelty,
    familiarity_score: 0,
    signals: {
      affinity: Math.max(0.25, score - 0.14),
      context: Math.max(0.25, score - 0.08),
      editorial: 0,
      track_popularity: popularity,
      novelty,
      familiarity: 0,
    },
    genres: [],
    reasons: ["Live Spotify search", intent.label, intent.reason],
    mention_count: 0,
    top_mention: null,
  };
}

async function spotifyJson<T>(
  url: string,
  accessToken: string,
  label: string,
  failures: Array<{ label: string; status: number | "error"; detail?: string }>
): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SPOTIFY_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      failures.push({ label, status: res.status, detail: detail.slice(0, 220) });
      return null;
    }
    return res.json().catch(() => null) as Promise<T | null>;
  } catch (err) {
    failures.push({
      label,
      status: "error",
      detail: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function spotifySearch<T>(
  query: string,
  type: "artist" | "track",
  limit: number,
  accessToken: string,
  label: string,
  failures: Array<{ label: string; status: number | "error"; detail?: string }>,
  hasItems: (data: T) => boolean
): Promise<T | null> {
  const withMarket = await spotifyJson<T>(
    spotifySearchUrl(query, type, limit, true),
    accessToken,
    `${label}:market`,
    failures
  );
  if (withMarket && hasItems(withMarket)) return withMarket;
  const withoutMarket = await spotifyJson<T>(
    spotifySearchUrl(query, type, limit, false),
    accessToken,
    `${label}:no-market`,
    failures
  );
  return withoutMarket ?? withMarket;
}

export async function POST(req: NextRequest) {
  const user = requireUser(req);
  if (isErrorResponse(user)) return user;

  const token = await getSpotifyToken(req);
  if (!token) {
    return NextResponse.json({ error: "no_spotify_token", results: [] }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const limit = Math.max(1, Math.min(Number(body.limit) || DEFAULT_LIMIT, DEFAULT_LIMIT));
  const spotifyFailures: Array<{ label: string; status: number | "error"; detail?: string }> = [];

  if (!prompt) {
    return applySpotifyTokenCookies(NextResponse.json({ results: [] }), token);
  }

  const artistMatchesById = new Map<string, SpotifyArtist>();
  const artistQueries = promptSearchVariants(prompt);
  for (const query of artistQueries) {
    const artistData = await spotifySearch<{ artists?: { items?: SpotifyArtist[] } }>(
      query,
      "artist",
      5,
      token.accessToken,
      `artist:${query}`,
      spotifyFailures,
      (data) => (data.artists?.items ?? []).length > 0
    );
    for (const artist of artistData?.artists?.items ?? []) {
      if (artist.id && !artistMatchesById.has(artist.id)) {
        artistMatchesById.set(artist.id, artist);
      }
    }
    if (artistMatchesById.size >= 3) break;
  }
  const artistMatches = [...artistMatchesById.values()].slice(0, 3);

  const artistTrackBatches = await Promise.all(
    artistMatches.map(async (artist, artistIndex) => {
      const data = await spotifyJson<{ tracks?: SpotifyTrack[] }>(
        `https://api.spotify.com/v1/artists/${encodeURIComponent(artist.id ?? "")}/top-tracks?market=US`,
        token.accessToken,
        `top-tracks:${artist.name ?? artist.id}`,
        spotifyFailures
      );
      return (data?.tracks ?? [])
        .slice(0, TRACKS_PER_INTENT)
        .map((track, trackIndex) =>
          trackToRecommendation(
            track,
            {
              query: artist.name ?? prompt,
              label: "Prompt artist match",
              reason: "Uses Spotify top tracks for the artist you typed.",
            },
            artistIndex,
            trackIndex
          )
        )
        .filter(Boolean);
    })
  );

  const rawQueries = [
    ...artistQueries,
    `${prompt} songs`,
    `${prompt} top tracks`,
    `artist:${prompt}`,
    `artist:"${prompt}"`,
  ];
  const queries = uniqueStrings(rawQueries);
  const trackSearchBatches = await Promise.all(
    queries.map(async (query, queryIndex) => {
      const data = await spotifySearch<{ tracks?: { items?: SpotifyTrack[] } }>(
        query,
        "track",
        TRACK_LIMIT,
        token.accessToken,
        `track:${query}`,
        spotifyFailures,
        (data) => (data.tracks?.items ?? []).length > 0
      );
      return chooseFallbackTracks(data?.tracks?.items ?? [])
        .map((track, trackIndex) =>
          trackToRecommendation(
            track,
            {
              query,
              label: "Prompt Spotify search",
              reason: "Searches Spotify directly for your typed artist, song, or scene.",
            },
            artistMatches.length + queryIndex,
            trackIndex
          )
        )
        .filter(Boolean);
    })
  );

  const seen = new Set<string>();
  const results = [...artistTrackBatches.flat(), ...trackSearchBatches.flat()]
    .sort((a, b) => (b?.score ?? 0) - (a?.score ?? 0))
    .filter((song) => {
      if (!song) return false;
      const key = song.spotify_track_id || `${song.track_name}|${song.artist_name}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);

  console.info("prompt-spotify-songs", {
    prompt,
    artist_count: artistMatches.length,
    result_count: results.length,
    artist_queries: artistQueries,
    spotify_failure_count: spotifyFailures.length,
    spotify_failures: spotifyFailures.slice(0, 5),
  });

  return applySpotifyTokenCookies(
    NextResponse.json({
      results,
      artist_count: artistMatches.length,
      track_search_count: results.length,
    }),
    token
  );
}
