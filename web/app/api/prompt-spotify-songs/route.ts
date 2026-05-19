import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";
import { applySpotifyTokenCookies, getSpotifyToken } from "@/lib/spotify-token";
import { supabaseServer } from "@/lib/supabase-server";

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
const TRACKS_PER_INTENT = 10;
const DEFAULT_LIMIT = 40;
const SPOTIFY_FETCH_TIMEOUT_MS = 8_000;
type SpotifyFailure = {
  label: string;
  status: number | "error";
  detail?: string;
  retry_after?: string | null;
};

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
    withoutBand,
  ]);
}

/**
 * Resolve prompt variants to artists already in our catalog by name.
 *
 * Cuts the most expensive Spotify call out of the hot path: every prompt
 * search hit `/v1/search?type=artist` before this, which is what tripped
 * the 429 (`retry_after: 8210s`) incident. For any artist already synced
 * via Spotify ingest (`artists.spotify_artist_id IS NOT NULL`) we can
 * skip the search entirely and feed the cached ID into top-tracks.
 *
 * Strategy:
 *   1. Exact case-insensitive match on `name` first (highest precision).
 *   2. ILIKE fallback for trailing/leading qualifiers (still bounded —
 *      we cap to 3 results to keep parity with the Spotify path).
 *
 * Returns SpotifyArtist-shaped rows so the downstream code paths don't
 * need to know whether the match came from the DB or live Spotify.
 */
async function resolveArtistsFromCatalog(queries: string[]): Promise<SpotifyArtist[]> {
  if (queries.length === 0) return [];

  let supabase;
  try {
    supabase = supabaseServer();
  } catch {
    // Env vars missing — degrade silently so the live path still tries Spotify.
    return [];
  }

  const seen = new Map<string, SpotifyArtist>();

  // Phase 1: exact case-insensitive name match across all prompt variants
  // (usually 1-2: the raw prompt and a "without band" stripped form).
  const variants = uniqueStrings(queries);
  for (const variant of variants) {
    if (seen.size >= 3) break;
    const lowered = variant.toLowerCase();
    if (!lowered) continue;
    try {
      const exact = await supabase
        .from("artists")
        .select("name,spotify_artist_id")
        .not("spotify_artist_id", "is", null)
        .ilike("name", lowered);
      for (const row of exact.data ?? []) {
        if (row.spotify_artist_id && !seen.has(row.spotify_artist_id)) {
          seen.set(row.spotify_artist_id, { id: row.spotify_artist_id, name: row.name ?? "" });
        }
      }
    } catch {
      // Lookup errors fall through to the Spotify path — never a hard fail.
    }
  }

  // Phase 2: ILIKE fallback only if nothing matched exactly.
  if (seen.size === 0) {
    try {
      const top = queries[0]?.replace(/[%_]/g, "").trim();
      if (top) {
        const fuzzy = await supabase
          .from("artists")
          .select("name,spotify_artist_id")
          .not("spotify_artist_id", "is", null)
          .ilike("name", `%${top}%`)
          .limit(3);
        for (const row of fuzzy.data ?? []) {
          if (row.spotify_artist_id && !seen.has(row.spotify_artist_id)) {
            seen.set(row.spotify_artist_id, { id: row.spotify_artist_id, name: row.name ?? "" });
          }
        }
      }
    } catch {
      // see above
    }
  }

  return [...seen.values()].slice(0, 3);
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

function hitSpotifyRateLimit(failures: SpotifyFailure[]): boolean {
  return failures.some((failure) => failure.status === 429);
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
  failures: SpotifyFailure[]
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
      failures.push({
        label,
        status: res.status,
        detail: detail.slice(0, 220),
        retry_after: res.headers.get("retry-after"),
      });
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
  failures: SpotifyFailure[],
  hasItems: (data: T) => boolean
): Promise<T | null> {
  const withMarket = await spotifyJson<T>(
    spotifySearchUrl(query, type, limit, true),
    accessToken,
    `${label}:market`,
    failures
  );
  if (withMarket && hasItems(withMarket)) return withMarket;
  const lastFailure = failures[failures.length - 1];
  if (lastFailure?.label === `${label}:market` && lastFailure.status === 429) {
    return withMarket;
  }
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
  const spotifyFailures: SpotifyFailure[] = [];

  if (!prompt) {
    return applySpotifyTokenCookies(NextResponse.json({ results: [] }), token);
  }

  const artistMatchesById = new Map<string, SpotifyArtist>();
  const artistQueries = promptSearchVariants(prompt);

  // Cache hit first: if the catalog already maps this prompt to a
  // synced artist, skip Spotify search entirely. This removes the call
  // that caused the 8210s app-wide 429 cooldown on "dave matthews band".
  const catalogMatches = await resolveArtistsFromCatalog(artistQueries);
  for (const artist of catalogMatches) {
    if (artist.id && !artistMatchesById.has(artist.id)) {
      artistMatchesById.set(artist.id, artist);
    }
  }
  const catalogHits = artistMatchesById.size;

  // Only fall through to Spotify search when the catalog didn't resolve
  // the prompt — keeps unknown queries working while protecting the rate
  // limit on the long tail of names we've already synced.
  if (catalogHits === 0) {
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
      if (hitSpotifyRateLimit(spotifyFailures)) break;
      for (const artist of artistData?.artists?.items ?? []) {
        if (artist.id && !artistMatchesById.has(artist.id)) {
          artistMatchesById.set(artist.id, artist);
        }
      }
      if (artistMatchesById.size >= 3) break;
    }
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
  ];
  const queries = uniqueStrings(rawQueries);
  const trackSearchBatches = await Promise.all(
    queries.map(async (query, queryIndex) => {
      if (hitSpotifyRateLimit(spotifyFailures)) return [];
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
    catalog_hits: catalogHits,
    result_count: results.length,
    artist_queries: artistQueries,
    spotify_failure_count: spotifyFailures.length,
    spotify_failures: spotifyFailures.slice(0, 5),
  });

  if (results.length === 0 && hitSpotifyRateLimit(spotifyFailures)) {
    const retryAfter = spotifyFailures.find((failure) => failure.status === 429)?.retry_after ?? null;
    return applySpotifyTokenCookies(
      NextResponse.json(
        {
          error: "spotify_rate_limited",
          retry_after: retryAfter,
          results: [],
          artist_count: artistMatches.length,
          track_search_count: 0,
        },
        { status: 429 }
      ),
      token
    );
  }

  return applySpotifyTokenCookies(
    NextResponse.json({
      results,
      artist_count: artistMatches.length,
      track_search_count: results.length,
    }),
    token
  );
}
