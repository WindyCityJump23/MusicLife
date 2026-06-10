import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";
import { applySpotifyTokenCookies, getSpotifyToken } from "@/lib/spotify-token";
import { supabaseServer } from "@/lib/supabase-server";
import { isExplicitUtilityTrackRequest, isUtilityTrack } from "@/lib/track-quality";

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

type SpotifyAlbum = {
  id?: string;
  name?: string;
  release_date?: string;
};

type SpotifyArtist = {
  id?: string;
  name?: string;
};

type CatalogArtist = SpotifyArtist & {
  catalogArtistId: number;
  genres: string[];
};

type CatalogTrack = {
  id?: number | string;
  name?: string;
  artist_id?: number | string | null;
  album_name?: string | null;
  release_date?: string | null;
  duration_ms?: number | null;
  explicit?: boolean | null;
  popularity?: number | null;
  instrumentalness?: number | null;
  speechiness?: number | null;
  spotify_track_id?: string | null;
  artists?: {
    id?: number | string;
    name?: string;
    genres?: string[] | null;
    spotify_artist_id?: string | null;
  } | Array<{
    id?: number | string;
    name?: string;
    genres?: string[] | null;
    spotify_artist_id?: string | null;
  }> | null;
};

type LiveIntent = {
  query: string;
  label: string;
  reason: string;
};

type DiscoveryLane = "deep_cuts" | "popular" | "radio_hits";

type TasteStrategy = {
  genre_boosts?: string[];
  genre_avoids?: string[];
  discovery_mix?: Partial<Record<DiscoveryLane, number>>;
  live_expansion?: "auto" | "catalog" | "live";
  freshness?: "newer" | "balanced" | "timeless";
};

type PromptWeights = {
  affinity: number;
  context: number;
  editorial: number;
};

type SongRecommendation = ReturnType<typeof trackToRecommendation> | ReturnType<typeof catalogTrackToRecommendation>;

const TRACK_LIMIT = 10;
const TRACKS_PER_INTENT = 10;
const DEFAULT_LIMIT = 40;
const CATALOG_TRACK_POOL_LIMIT = 120;
const ARTIST_ALBUM_LIMIT = 8;
const ALBUM_TRACK_LIMIT = 8;
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

function laneFromPopularity(popularity: number): DiscoveryLane {
  if (popularity < 0.46) return "deep_cuts";
  if (popularity >= 0.74) return "radio_hits";
  return "popular";
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizeList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item).trim().toLowerCase()).filter(Boolean).slice(0, 12)
    : [];
}

function normalizeTasteStrategy(value: unknown): TasteStrategy | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const mix = raw.discovery_mix && typeof raw.discovery_mix === "object"
    ? raw.discovery_mix as Record<string, unknown>
    : {};
  const liveExpansion = raw.live_expansion === "catalog" || raw.live_expansion === "live"
    ? raw.live_expansion
    : "auto";
  const freshness = raw.freshness === "newer" || raw.freshness === "timeless"
    ? raw.freshness
    : "balanced";

  return {
    genre_boosts: normalizeList(raw.genre_boosts),
    genre_avoids: normalizeList(raw.genre_avoids),
    discovery_mix: {
      deep_cuts: Number(mix.deep_cuts) || 38,
      popular: Number(mix.popular) || 38,
      radio_hits: Number(mix.radio_hits) || 24,
    },
    live_expansion: liveExpansion,
    freshness,
  };
}

function normalizeWeights(value: unknown): PromptWeights {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const affinity = Number(raw.affinity);
  const context = Number(raw.context);
  const editorial = Number(raw.editorial);
  return {
    affinity: Number.isFinite(affinity) ? clamp01(affinity) : 0.75,
    context: Number.isFinite(context) ? clamp01(context) : 0.15,
    editorial: Number.isFinite(editorial) ? clamp01(editorial) : 0.1,
  };
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededJitter(seed: string, key: string, amplitude: number): number {
  if (!seed) return 0;
  const unit = hashString(`${seed}:${key}`) / 0xffffffff;
  return (unit - 0.5) * amplitude;
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
async function resolveArtistsFromCatalog(queries: string[]): Promise<CatalogArtist[]> {
  if (queries.length === 0) return [];

  let supabase;
  try {
    supabase = supabaseServer();
  } catch {
    // Env vars missing — degrade silently so the live path still tries Spotify.
    return [];
  }

  const seen = new Map<string, CatalogArtist>();

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
        .select("id,name,genres,spotify_artist_id")
        .not("spotify_artist_id", "is", null)
        .ilike("name", lowered)
        .limit(3);
      for (const row of exact.data ?? []) {
        if (row.id && row.spotify_artist_id && !seen.has(row.spotify_artist_id)) {
          seen.set(row.spotify_artist_id, {
            id: row.spotify_artist_id,
            name: row.name ?? "",
            catalogArtistId: Number(row.id),
            genres: Array.isArray(row.genres) ? row.genres : [],
          });
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
          .select("id,name,genres,spotify_artist_id")
          .not("spotify_artist_id", "is", null)
          .ilike("name", `%${top}%`)
          .limit(3);
        for (const row of fuzzy.data ?? []) {
          if (row.id && row.spotify_artist_id && !seen.has(row.spotify_artist_id)) {
            seen.set(row.spotify_artist_id, {
              id: row.spotify_artist_id,
              name: row.name ?? "",
              catalogArtistId: Number(row.id),
              genres: Array.isArray(row.genres) ? row.genres : [],
            });
          }
        }
      }
    } catch {
      // see above
    }
  }

  return [...seen.values()].slice(0, 3);
}

async function fetchCatalogTracksForArtists(
  artists: CatalogArtist[],
  perArtistLimit: number
): Promise<CatalogTrack[]> {
  if (artists.length === 0) return [];

  let supabase;
  try {
    supabase = supabaseServer();
  } catch {
    return [];
  }

  const batches = await Promise.all(
    artists.map(async (artist) => {
      try {
        const { data, error } = await supabase
          .from("tracks")
          .select(
            "id,name,artist_id,album_name,release_date,duration_ms,explicit,popularity,instrumentalness,speechiness,spotify_track_id,artists(id,name,genres,spotify_artist_id)"
          )
          .eq("artist_id", artist.catalogArtistId)
          .not("spotify_track_id", "is", null)
          .order("popularity", { ascending: false, nullsFirst: false })
          .limit(perArtistLimit);
        if (error) {
          console.warn("prompt-spotify-songs: catalog track lookup failed", {
            artist: artist.name,
            error: error.message,
          });
          return [];
        }
        return data ?? [];
      } catch (err) {
        console.warn("prompt-spotify-songs: catalog track lookup threw", {
          artist: artist.name,
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      }
    })
  );

  return batches.flat() as CatalogTrack[];
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

function chooseFallbackTracks(tracks: SpotifyTrack[], allowUtilityTracks = false): SpotifyTrack[] {
  const seen = new Set<string>();
  const unique = tracks.filter((track) => {
    if (!allowUtilityTracks && isUtilityTrack(track)) return false;
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
  trackIndex: number,
  allowUtilityTracks = false
) {
  const artist = track.artists?.[0];
  if (!track.id || !track.name || !artist?.name || (!allowUtilityTracks && isUtilityTrack(track))) {
    return null;
  }

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
      saved_anchor: 0,
      listen_boost: 0,
      audio_match: null,
      live_source: true,
    },
    genres: [],
    reasons: ["Live Spotify search", intent.label, intent.reason],
    mention_count: 0,
    top_mention: null,
  };
}

function catalogTrackToRecommendation(
  track: CatalogTrack,
  fallbackArtist: CatalogArtist | undefined,
  artistIndex: number,
  trackIndex: number,
  allowUtilityTracks = false
) {
  const artist = Array.isArray(track.artists) ? track.artists[0] : track.artists;
  const artistName = artist?.name ?? fallbackArtist?.name;
  const spotifyTrackId = track.spotify_track_id ?? "";
  if (
    !track.id ||
    !track.name ||
    !artistName ||
    !spotifyTrackId ||
    (!allowUtilityTracks && isUtilityTrack(track))
  ) {
    return null;
  }

  const popularity = Math.max(0, Math.min(1, (track.popularity ?? 50) / 100));
  const freshness = releaseFreshness(track.release_date);
  const novelty = Math.max(0.25, Math.min(1, 1 - popularity * 0.55 + freshness * 0.25));
  const score = scoreTrack(
    {
      id: spotifyTrackId,
      name: track.name,
      popularity: track.popularity ?? 50,
      duration_ms: track.duration_ms ?? 0,
      explicit: track.explicit ?? false,
      album: {
        name: track.album_name ?? "",
        release_date: track.release_date ?? undefined,
      },
      artists: [{ id: artist?.spotify_artist_id ?? fallbackArtist?.id, name: artistName }],
    },
    artistIndex + 1,
    trackIndex
  );
  const genres = Array.isArray(artist?.genres)
    ? artist.genres
    : Array.isArray(fallbackArtist?.genres)
      ? fallbackArtist.genres
      : [];

  return {
    track_id: String(track.id),
    track_name: track.name,
    artist_id: String(track.artist_id ?? fallbackArtist?.catalogArtistId ?? ""),
    artist_name: artistName,
    album_name: track.album_name ?? "",
    release_date: track.release_date ?? null,
    duration_ms: track.duration_ms ?? 0,
    explicit: track.explicit ?? false,
    spotify_track_id: spotifyTrackId,
    score,
    lane: laneFromPopularity(popularity),
    novelty_score: novelty,
    familiarity_score: 0,
    signals: {
      affinity: Math.max(0.3, score - 0.08),
      context: Math.max(0.25, score - 0.1),
      editorial: 0,
      track_popularity: popularity,
      novelty,
      familiarity: 0,
      saved_anchor: Math.max(0.3, score - 0.08),
      listen_boost: 0,
      audio_match: null,
      live_source: false,
    },
    genres,
    reasons: [
      "Catalog artist match",
      "Matched the artist you typed in the MusicLife catalog.",
      "Used playable catalog tracks when live Spotify search was limited or unnecessary.",
    ],
    mention_count: 0,
    top_mention: null,
  };
}

function dedupeRecommendations<T extends { spotify_track_id?: string; track_name?: string; artist_name?: string }>(
  songs: Array<T | null | undefined>,
  limit: number
): T[] {
  const seen = new Set<string>();
  return songs
    .filter((song): song is T => {
      if (!song) return false;
      const key = song.spotify_track_id || `${song.track_name ?? ""}|${song.artist_name ?? ""}`.toLowerCase();
      if (!key.trim() || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

function genreAdjustment(genres: string[], strategy: TasteStrategy | null): number {
  if (!strategy) return 0;
  const genreText = genres.join(" ").toLowerCase();
  const boosts = normalizeList(strategy.genre_boosts);
  const avoids = normalizeList(strategy.genre_avoids);
  const boostHit = boosts.some((genre) => genreText.includes(genre));
  const avoidHit = avoids.some((genre) => genreText.includes(genre));
  return (boostHit ? 0.08 : 0) + (avoidHit ? -0.12 : 0);
}

function freshnessAdjustment(releaseDate: string | null | undefined, strategy: TasteStrategy | null): number {
  if (!strategy || strategy.freshness === "balanced") return 0;
  const freshness = releaseFreshness(releaseDate);
  if (strategy.freshness === "newer") return (freshness - 0.45) * 0.16;
  return (0.65 - freshness) * 0.1;
}

function lanePreferenceAdjustment(lane: DiscoveryLane, strategy: TasteStrategy | null): number {
  const defaultMix = { deep_cuts: 38, popular: 38, radio_hits: 24 };
  const mix = strategy?.discovery_mix ?? defaultMix;
  const desired = Number(mix[lane] ?? defaultMix[lane]);
  return ((desired - defaultMix[lane]) / 100) * 0.18;
}

function retuneSongScore(
  song: Exclude<SongRecommendation, null>,
  strategy: TasteStrategy | null,
  weights: PromptWeights,
  seed: string
): number {
  const lane = laneFromPopularity(song.signals.track_popularity ?? 0.5);
  const popularity = song.signals.track_popularity ?? 0.5;
  const trackKey = song.spotify_track_id || `${song.track_name}|${song.artist_name}`;
  const stayClose = weights.affinity * (song.track_id === null ? 0.01 : 0.04);
  const liveSearch = weights.context * (song.track_id === null ? 0.06 : -0.01);
  const buzz = weights.editorial * ((popularity - 0.5) * 0.08 + releaseFreshness(song.release_date) * 0.04);
  const jitter = seededJitter(seed, trackKey, 0.055);

  return Number(
    Math.max(
      0.01,
      Math.min(
        0.99,
        song.score +
          lanePreferenceAdjustment(lane, strategy) +
          genreAdjustment(song.genres, strategy) +
          freshnessAdjustment(song.release_date, strategy) +
          stayClose +
          liveSearch +
          buzz +
          jitter
      )
    ).toFixed(4)
  );
}

function laneTargets(limit: number, strategy: TasteStrategy | null): Record<DiscoveryLane, number> {
  const mix = strategy?.discovery_mix ?? { deep_cuts: 38, popular: 38, radio_hits: 24 };
  const deepCuts = Math.max(0, Number(mix.deep_cuts) || 0);
  const popular = Math.max(0, Number(mix.popular) || 0);
  const radioHits = Math.max(0, Number(mix.radio_hits) || 0);
  const total = deepCuts + popular + radioHits || 100;
  return {
    deep_cuts: Math.round(limit * deepCuts / total),
    popular: Math.round(limit * popular / total),
    radio_hits: Math.round(limit * radioHits / total),
  };
}

function shapeRecommendations(
  songs: Array<SongRecommendation | null | undefined>,
  limit: number,
  strategy: TasteStrategy | null,
  weights: PromptWeights,
  seed: string
) {
  const scored = dedupeRecommendations(songs, CATALOG_TRACK_POOL_LIMIT)
    .map((song) => {
      const score = retuneSongScore(song, strategy, weights, seed);
      return {
        ...song,
        score,
        lane: laneFromPopularity(song.signals.track_popularity ?? 0.5),
      };
    })
    .sort((a, b) => b.score - a.score);

  const targets = laneTargets(limit, strategy);
  const selected: typeof scored = [];
  const seen = new Set<string>();
  const lanes: DiscoveryLane[] = ["deep_cuts", "popular", "radio_hits"];

  function add(song: (typeof scored)[number] | undefined): boolean {
    if (!song || selected.length >= limit) return false;
    const key = song.spotify_track_id || `${song.track_name}|${song.artist_name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    selected.push(song);
    return true;
  }

  for (const lane of lanes) {
    let added = 0;
    for (const song of scored) {
      if (added >= targets[lane]) break;
      if (song.lane !== lane) continue;
      if (add(song)) added += 1;
    }
  }

  for (const song of scored) {
    if (selected.length >= limit) break;
    add(song);
  }

  return selected;
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

async function fetchSpotifyArtistCatalogTracks(
  artist: SpotifyArtist,
  artistIndex: number,
  accessToken: string,
  failures: SpotifyFailure[],
  allowUtilityTracks: boolean
) {
  if (!artist.id) return [];

  const albumData = await spotifyJson<{ items?: SpotifyAlbum[] }>(
    `https://api.spotify.com/v1/artists/${encodeURIComponent(artist.id)}/albums?include_groups=album,single&market=US&limit=${ARTIST_ALBUM_LIMIT}`,
    accessToken,
    `albums:${artist.name ?? artist.id}`,
    failures
  );

  const seenAlbums = new Set<string>();
  const albums = (albumData?.items ?? [])
    .filter((album) => {
      if (!album.id || !album.name) return false;
      const key = album.name
        .toLowerCase()
        .replace(/\s*\(.*?\)\s*/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!key || seenAlbums.has(key)) return false;
      seenAlbums.add(key);
      return true;
    })
    .slice(0, ARTIST_ALBUM_LIMIT);

  const albumTrackBatches = await Promise.all(
    albums.map(async (album, albumIndex) => {
      if (!album.id) return [];
      const data = await spotifyJson<{ items?: SpotifyTrack[] }>(
        `https://api.spotify.com/v1/albums/${encodeURIComponent(album.id)}/tracks?market=US&limit=50`,
        accessToken,
        `album-tracks:${album.name ?? album.id}`,
        failures
      );
      return (data?.items ?? [])
        .slice(0, ALBUM_TRACK_LIMIT)
        .map((track, trackIndex) => ({
          ...track,
          popularity: track.popularity ?? Math.max(35, 68 - albumIndex * 4 - trackIndex),
          album: {
            name: album.name,
            release_date: album.release_date,
          },
        }))
        .map((track, trackIndex) =>
          trackToRecommendation(
            track,
            {
              query: artist.name ?? "",
              label: "Prompt artist catalog",
              reason: "Expands the artist you typed through Spotify album tracks instead of the restricted top-tracks endpoint.",
            },
            artistIndex,
            albumIndex * ALBUM_TRACK_LIMIT + trackIndex,
            allowUtilityTracks
          )
        )
        .filter(Boolean);
    })
  );

  return albumTrackBatches.flat();
}

export async function POST(req: NextRequest) {
  const user = requireUser(req);
  if (isErrorResponse(user)) return user;

  const body = await req.json().catch(() => ({}));
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const limit = Math.max(1, Math.min(Number(body.limit) || DEFAULT_LIMIT, DEFAULT_LIMIT));
  const tasteStrategy = normalizeTasteStrategy(body.taste_strategy);
  const weights = normalizeWeights(body.weights);
  const retuneSeed = typeof body.discover_run_id === "string" && body.discover_run_id.trim()
    ? body.discover_run_id.trim()
    : `${Date.now()}:${Math.random()}`;
  const spotifyFailures: SpotifyFailure[] = [];
  const allowUtilityTracks = isExplicitUtilityTrackRequest(prompt);

  if (!prompt) {
    return NextResponse.json({ results: [] });
  }

  const artistMatchesById = new Map<string, SpotifyArtist | CatalogArtist>();
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
  const catalogTrackRows = await fetchCatalogTracksForArtists(
    catalogMatches,
    Math.max(limit * 3, Math.min(CATALOG_TRACK_POOL_LIMIT, 80))
  );
  const catalogTrackRecommendations = catalogTrackRows
    .map((track, trackIndex) => {
      const artistIndex = catalogMatches.findIndex((match) => match.catalogArtistId === Number(track.artist_id));
      const artist = artistIndex >= 0 ? catalogMatches[artistIndex] : undefined;
      return catalogTrackToRecommendation(
        track,
        artist,
        Math.max(0, artistIndex),
        trackIndex,
        allowUtilityTracks
      );
    })
    .filter(Boolean);

  const token = await getSpotifyToken(req);
  if (!token) {
    if (catalogTrackRecommendations.length > 0) {
      const results = shapeRecommendations(catalogTrackRecommendations, limit, tasteStrategy, weights, retuneSeed);
      console.info("prompt-spotify-songs", {
        prompt,
        artist_count: catalogMatches.length,
        catalog_hits: catalogHits,
        catalog_track_count: catalogTrackRecommendations.length,
        result_count: results.length,
        artist_queries: artistQueries,
        taste_strategy_applied: Boolean(tasteStrategy),
        retune_seed: retuneSeed,
        spotify_failure_count: 0,
        spotify_failures: [],
        used_catalog_without_token: true,
      });
      return NextResponse.json({
        results,
        artist_count: catalogMatches.length,
        track_search_count: results.length,
        catalog_track_count: catalogTrackRecommendations.length,
      });
    }
    return NextResponse.json({ error: "no_spotify_token", results: [] }, { status: 401 });
  }

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
      return fetchSpotifyArtistCatalogTracks(
        artist,
        artistIndex,
        token.accessToken,
        spotifyFailures,
        allowUtilityTracks
      );
    })
  );
  const artistTrackRecommendations = artistTrackBatches.flat();

  const preliminaryResults = shapeRecommendations(
    [...artistTrackRecommendations, ...catalogTrackRecommendations],
    limit,
    tasteStrategy,
    weights,
    retuneSeed
  );

  const rawQueries = [
    ...artistQueries,
    `${prompt} songs`,
  ];
  const queries = uniqueStrings(rawQueries);
  const shouldRunTrackSearch =
    !hitSpotifyRateLimit(spotifyFailures) &&
    (
      preliminaryResults.length < limit ||
      tasteStrategy?.live_expansion === "live" ||
      weights.context >= 0.45 ||
      weights.editorial >= 0.35
    );
  const trackSearchBatches = shouldRunTrackSearch
    ? await Promise.all(
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
          return chooseFallbackTracks(data?.tracks?.items ?? [], allowUtilityTracks)
            .map((track, trackIndex) =>
              trackToRecommendation(
                track,
                {
                  query,
                  label: "Prompt Spotify search",
                  reason: "Searches Spotify directly for your typed artist, song, or scene.",
                },
                artistMatches.length + queryIndex,
                trackIndex,
                allowUtilityTracks
              )
            )
            .filter(Boolean);
        })
      )
    : [];

  const results = shapeRecommendations(
    [...artistTrackRecommendations, ...trackSearchBatches.flat(), ...catalogTrackRecommendations],
    limit,
    tasteStrategy,
    weights,
    retuneSeed
  );

  console.info("prompt-spotify-songs", {
    prompt,
    artist_count: artistMatches.length,
    catalog_hits: catalogHits,
    catalog_track_count: catalogTrackRecommendations.length,
    spotify_artist_track_count: artistTrackRecommendations.length,
    result_count: results.length,
    artist_queries: artistQueries,
    ran_track_search: shouldRunTrackSearch,
    taste_strategy_applied: Boolean(tasteStrategy),
    retune_seed: retuneSeed,
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
          catalog_track_count: catalogTrackRecommendations.length,
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
      catalog_track_count: catalogTrackRecommendations.length,
    }),
    token
  );
}
