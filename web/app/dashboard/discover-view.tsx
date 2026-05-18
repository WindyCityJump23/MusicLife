"use client";

import { useEffect, useRef, useState } from "react";
import { usePlayer, type QueueTrack } from "./player-context";

type SignalBreakdown = {
  affinity: number;
  context: number;
  editorial: number;
  track_popularity?: number;
  novelty?: number;
  familiarity?: number;
};
type TopMention = {
  source: string;
  source_url?: string;
  article_url?: string;
  excerpt: string;
  published_at: string;
};

type SongRecommendation = {
  track_id: string | null;
  track_name: string;
  artist_id: string;
  artist_name: string;
  album_name: string;
  release_date: string | null;
  duration_ms: number;
  explicit: boolean;
  spotify_track_id: string;
  score: number;
  lane?: DiscoveryLaneId | "radio_hit" | "deep_cut" | "familiar";
  novelty_score?: number;
  familiarity_score?: number;
  signals: SignalBreakdown;
  reasons: string[];
  genres: string[];
  mention_count: number;
  top_mention: TopMention | null;
};

type Preset = { label: string; desc: string; weights: { affinity: number; context: number; editorial: number } };

type DiscoveryLaneId = "radio_hits" | "popular" | "deep_cuts";

type DiscoveryLane = {
  id: DiscoveryLaneId;
  title: string;
  subtitle: string;
};

type LaneFilterId = "all" | DiscoveryLaneId;

type RadioReadinessSummary = {
  artistCount: number;
  embeddedCount: number;
  playableTrackCount: number;
};

type TasteStrategy = {
  genre_boosts: string[];
  genre_avoids: string[];
  discovery_mix: {
    deep_cuts: number;
    popular: number;
    radio_hits: number;
  };
  live_expansion: "auto" | "catalog" | "live";
  freshness: "newer" | "balanced" | "timeless";
};

function emptyDiscoveryGroups(): Record<DiscoveryLaneId, SongRecommendation[]> {
  return {
    radio_hits: [],
    popular: [],
    deep_cuts: [],
  };
}


const PRESETS: Preset[] = [
  { label: "Balanced",      desc: "Equal blend of all three signals",         weights: { affinity: 40, context: 40, editorial: 20 } },
  { label: "Pure Taste",    desc: "Closest to your saved listening history",   weights: { affinity: 75, context: 15, editorial: 10 } },
  { label: "Trending",      desc: "Artists getting press buzz right now",      weights: { affinity: 25, context: 15, editorial: 60 } },
  { label: "Match Search",  desc: "Type a prompt above to activate this mode", weights: { affinity: 20, context: 65, editorial: 15 } },
];

const DISCOVERY_LANES: DiscoveryLane[] = [
  {
    id: "radio_hits",
    title: "Radio hits",
    subtitle: "High-recognition songs",
  },
  {
    id: "popular",
    title: "Popular",
    subtitle: "Known, but less obvious",
  },
  {
    id: "deep_cuts",
    title: "Deep cuts / indie",
    subtitle: "Lower-popularity finds",
  },
];

const LANE_FILTERS: Array<{ id: LaneFilterId; label: string }> = [
  { id: "all", label: "All" },
  { id: "deep_cuts", label: "Deep cuts" },
  { id: "popular", label: "Popular" },
  { id: "radio_hits", label: "Radio hits" },
];

const TARGET_SONGS = 25;
const FALLBACK_ARTIST_SEARCH_LIMIT = 15;
const FALLBACK_TRACK_SEARCH_LIMIT = 20;
const LIVE_EXPANSION_INTENT_LIMIT = 7;
const LIVE_EXPANSION_TRACK_LIMIT = 12;
const LIVE_EXPANSION_TRACKS_PER_INTENT = 5;
const LIVE_EXPANSION_POOL_TARGET = 40;
const FRESH_AIR_TARGET_RATIO = 0.25;
const DISCOVER_CACHE_KEY = "musiclife:discover:last-results:v3";
const DISCOVER_CACHE_TTL_MS = 10 * 60 * 1000;

type DiscoverCachePayload = {
  savedAt: number;
  prompt: string;
  weights: Preset["weights"];
  strategyKey: string;
  results: SongRecommendation[];
};

type PlaylistCreateResponse = {
  ok?: boolean;
  error?: string;
  playlist_url?: string;
  playlist_id?: string;
  playlist_name?: string;
  add_tracks_client_side?: boolean;
  server_add_error?: string;
  track_uris?: string[];
  tracks_added?: number;
  tracks_failed?: string[];
};

type LiveSearchIntent = {
  query: string;
  label?: string;
  reason?: string;
};

type LiveCandidateIntentsResponse = {
  intents?: LiveSearchIntent[];
  source?: "anthropic" | "heuristic";
};

function laneForSong(song: SongRecommendation): DiscoveryLaneId {
  // Prefer backend-assigned lane when available
  if (song.lane) {
    if (song.lane === "deep_cuts" || song.lane === "deep_cut") return "deep_cuts";
    if (song.lane === "radio_hits" || song.lane === "radio_hit" || song.lane === "familiar") return "radio_hits";
    if (song.lane === "popular") return "popular";
  }

  const popularity = song.signals.track_popularity ?? 0.5;
  const reasons = song.reasons.join(" ").toLowerCase();
  const genres = song.genres.join(" ").toLowerCase();
  const hasDeepSignal =
    reasons.includes("deep cut") ||
    reasons.includes("obscure") ||
    genres.includes("indie") ||
    genres.includes("underground");

  if (hasDeepSignal || popularity < 0.46) return "deep_cuts";
  if (popularity >= 0.74) return "radio_hits";
  return "popular";
}

function laneBadge(song: SongRecommendation): { label: string; className: string } | null {
  if (!song.lane) return null;
  const lane = laneForSong(song);
  if (lane === "deep_cuts") {
    return { label: "Deep cut", className: "bg-violet-50 text-violet-600" };
  }
  if (lane === "popular") {
    return { label: "Popular", className: "bg-amber-50 text-amber-600" };
  }
  return { label: "Radio hit", className: "bg-emerald-50 text-emerald-600" };
}

function pct(value: number | undefined): number {
  return Math.round(Math.max(0, Math.min(1, value ?? 0)) * 100);
}

function topSignal(song: SongRecommendation): { label: string; value: number } {
  const signals = [
    { label: "Taste", value: song.signals.affinity ?? 0 },
    { label: "Search", value: song.signals.context ?? 0 },
    { label: "Buzz", value: song.signals.editorial ?? 0 },
  ];
  return signals.sort((a, b) => b.value - a.value)[0] ?? signals[0];
}

function readableReason(reason: string): string {
  const normalized = reason.trim();
  const lower = normalized.toLowerCase();
  if (lower === "matches your taste") return "matches your taste profile";
  if (lower === "matches your search") return "matches your prompt";
  if (lower === "fits your vibe") return "fits the current blend";
  if (lower === "popular track") return "has strong Spotify traction";
  if (lower === "new release") return "recent release";
  if (lower === "already in your library") return "familiar from your library";
  if (lower === "recently surfaced") return "recently surfaced in MusicLife";
  if (lower === "live spotify search") return "came from a live Spotify search outside the catalog";
  if (lower === "outside catalog") return "was sourced outside the local catalog";
  if (lower === "prompt expansion") return "matches a live expansion of your prompt";
  if (lower === "mood expansion") return "matches a live mood expansion";
  if (lower === "fresh genre search") return "came from a fresh live genre search";
  if (lower === "deep search") return "came from a deeper live search";
  if (lower === "recent search") return "came from a recent-year live search";
  if (lower === "curated pick") return "balanced discovery pick";
  return normalized.charAt(0).toLowerCase() + normalized.slice(1);
}

function buildWhyExplanation(
  song: SongRecommendation,
  currentPrompt: string
): { summary: string; details: string[] } {
  const leader = topSignal(song);
  const details: string[] = [];
  const seen = new Set<string>();

  function add(detail: string | null | undefined) {
    const clean = detail?.trim();
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    details.push(clean);
  }

  add(`${leader.label} is the strongest signal at ${pct(leader.value)}%.`);
  song.reasons.slice(0, 3).forEach((reason) => {
    add(`It ${readableReason(reason)}.`);
  });
  if (currentPrompt.trim() && (song.signals.context ?? 0) > 0.15) {
    add(`It lines up with "${currentPrompt.trim()}".`);
  }
  if (song.top_mention?.source) {
    add(`It has recent context from ${song.top_mention.source}.`);
  }
  if ((song.signals.novelty ?? 0) >= 0.65) {
    add("It should feel more discovery than repeat listen.");
  } else if ((song.signals.familiarity ?? 0) >= 0.45) {
    add("It stays close to music you already know.");
  }
  if (song.genres.length > 0) {
    add(`Genre fit: ${song.genres.slice(0, 3).join(", ")}.`);
  }

  const source = song.top_mention?.source ? `, with ${song.top_mention.source} context` : "";
  const summary =
    song.reasons.length > 0
      ? `${readableReason(song.reasons[0])}; ${leader.label.toLowerCase()} ${pct(leader.value)}%${source}`
      : `${leader.label} ${pct(leader.value)}%${source}`;

  return { summary, details };
}

function targetLaneCounts(total: number): { radio_hits: number; deep_cuts: number } {
  if (total <= 1) return { radio_hits: total, deep_cuts: 0 };
  if (total === 2) return { radio_hits: 1, deep_cuts: 1 };

  const radio_hits = Math.max(1, Math.round(total * 0.24));
  const deep_cuts = Math.max(1, Math.round(total * 0.32));
  const overflow = Math.max(0, radio_hits + deep_cuts - (total - 1));

  return {
    radio_hits,
    deep_cuts: Math.max(1, deep_cuts - overflow),
  };
}

function groupSongsByLane(songs: SongRecommendation[]): Record<DiscoveryLaneId, SongRecommendation[]> {
  if (songs.length === 0) {
    return emptyDiscoveryGroups();
  }

  const assigned = songs.map((song, originalIndex) => ({
    song,
    originalIndex,
    lane: null as DiscoveryLaneId | null,
    preferredLane: song.lane ?? laneForSong(song),
    popularity: song.signals.track_popularity ?? 0.5,
  }));
  const targets = targetLaneCounts(songs.length);
  const byRecognition = [...assigned].sort(
    (a, b) => b.popularity - a.popularity || a.originalIndex - b.originalIndex
  );

  assigned
    .filter(({ preferredLane }) => preferredLane === "deep_cuts")
    .forEach((item) => {
      item.lane = "deep_cuts";
              });

  assigned
    .filter(({ preferredLane, lane }) => preferredLane === "radio_hits" && lane === null)
    .forEach((item) => {
      item.lane = "radio_hits";
    });

  byRecognition
    .filter(({ lane }) => lane === null)
    .slice(0, Math.max(0, targets.radio_hits - assigned.filter(({ lane }) => lane === "radio_hits").length))
    .forEach((item) => {
      item.lane = "radio_hits";
    });

  [...byRecognition]
    .reverse()
    .filter(({ lane }) => lane === null)
    .slice(0, Math.max(0, targets.deep_cuts - assigned.filter(({ lane }) => lane === "deep_cuts").length))
    .forEach((item) => {
      item.lane = "deep_cuts";
    });

  assigned
    .filter(({ lane }) => lane === null)
    .forEach((item) => {
      item.lane = "popular";
    });

  return assigned
    .sort((a, b) => a.originalIndex - b.originalIndex)
    .reduce<Record<DiscoveryLaneId, SongRecommendation[]>>(
      (groups, item) => {
        groups[item.lane ?? "popular"].push(item.song);
        return groups;
      },
      emptyDiscoveryGroups()
    );
}

function interleaveForPlayback(songs: SongRecommendation[]): SongRecommendation[] {
  const groups = groupSongsByLane(songs);
  const order: DiscoveryLaneId[] = ["deep_cuts", "popular", "radio_hits"];
  const mixed: SongRecommendation[] = [];
  let index = 0;

  while (mixed.length < songs.length) {
    let added = false;
    for (const lane of order) {
      const song = groups[lane][index];
      if (song) {
        mixed.push(song);
        added = true;
      }
    }
    if (!added) break;
    index += 1;
  }

  return mixed;
}

function activePresetLabel(weights: Preset["weights"]): string {
  return PRESETS.find((preset) => sameWeights(preset.weights, weights))?.label ?? "Custom";
}

function isLiveSourced(song: SongRecommendation): boolean {
  const reasons = song.reasons.join(" ").toLowerCase();
  return (
    song.track_id === null ||
    String(song.artist_id).startsWith("live:") ||
    reasons.includes("live spotify") ||
    reasons.includes("outside catalog") ||
    reasons.includes("prompt expansion") ||
    reasons.includes("mood expansion")
  );
}

function laneLabel(lane: LaneFilterId): string {
  if (lane === "all") return "All";
  return DISCOVERY_LANES.find((item) => item.id === lane)?.title ?? "All";
}

function stationMixSummary(
  songs: SongRecommendation[],
  prompt: string,
  weights: Preset["weights"]
) {
  const groups = groupSongsByLane(songs);
  const liveCount = songs.filter(isLiveSourced).length;
  const catalogCount = Math.max(0, songs.length - liveCount);
  const hasPrompt = Boolean(prompt.trim());
  const targetFreshAir = freshAirTarget(songs.length);
  let sourceInsight = "MusicLife now reserves outside air for freshness when Spotify can supply strong live candidates, even when the catalog is healthy.";
  if (liveCount > 0 && catalogCount > 0) {
    sourceInsight = hasPrompt
      ? "Expanded outside the catalog for this prompt while keeping modeled tracks as the base."
      : `Added outside-air Spotify matches to keep the station fresh beyond the modeled catalog. Target: about ${targetFreshAir} of ${songs.length}.`;
  } else if (liveCount > 0) {
    sourceInsight = "Built from live Spotify because the catalog did not return enough playable matches.";
  } else if (songs.length === 0) {
    sourceInsight = "Tune the station to see whether the queue comes from the catalog, live Spotify, or both.";
  } else {
    sourceInsight = "Why 0? Spotify search did not return usable outside-air candidates for this run, or the session could not access live Spotify. The catalog still filled the station.";
  }

  return {
    total: songs.length,
    liveCount,
    catalogCount,
    sourceInsight,
    promptLabel: prompt.trim() || "Taste radio",
    presetLabel: activePresetLabel(weights),
    laneCounts: {
      deep_cuts: groups.deep_cuts.length,
      popular: groups.popular.length,
      radio_hits: groups.radio_hits.length,
    },
  };
}

function trackIdentity(song: SongRecommendation): string {
  return (
    song.spotify_track_id ||
    `${song.track_name.toLowerCase()}|${song.artist_name.toLowerCase()}`
  );
}

function artistIdentity(song: SongRecommendation): string {
  return String(song.artist_id || song.artist_name).toLowerCase();
}

function spreadArtistsForDisplay(
  songs: SongRecommendation[],
  target: number
): SongRecommendation[] {
  const selected: SongRecommendation[] = [];
  const seenTracks = new Set<string>();
  const artistCounts = new Map<string, number>();

  function addPass(maxPerArtist: number, requireUniqueArtist: boolean) {
    for (const song of songs) {
      if (selected.length >= target) break;
      const trackKey = trackIdentity(song);
      if (seenTracks.has(trackKey)) continue;

      const artistKey = artistIdentity(song);
      const count = artistCounts.get(artistKey) ?? 0;
      if (requireUniqueArtist && count > 0) continue;
      if (count >= maxPerArtist) continue;

      selected.push(song);
      seenTracks.add(trackKey);
      artistCounts.set(artistKey, count + 1);
    }
  }

  addPass(1, true);
  if (selected.length < target) addPass(2, false);
  if (selected.length < target) addPass(3, false);

  return selected;
}

function freshAirTarget(total: number): number {
  if (total <= 0) return 0;
  return Math.max(1, Math.ceil(total * FRESH_AIR_TARGET_RATIO));
}

function interleaveFreshAir(
  catalogSongs: SongRecommendation[],
  liveSongs: SongRecommendation[],
  target: number
): SongRecommendation[] {
  const result: SongRecommendation[] = [];
  const seen = new Set<string>();
  const cadence = Math.max(2, Math.floor(target / Math.max(1, liveSongs.length)));
  let catalogIndex = 0;
  let liveIndex = 0;

  function add(song: SongRecommendation | undefined): boolean {
    if (!song || result.length >= target) return false;
    const key = trackIdentity(song);
    if (seen.has(key)) return false;
    seen.add(key);
    result.push(song);
    return true;
  }

  while (result.length < target && (catalogIndex < catalogSongs.length || liveIndex < liveSongs.length)) {
    if ((result.length + 1) % cadence === 0 && liveIndex < liveSongs.length) {
      add(liveSongs[liveIndex]);
      liveIndex += 1;
      continue;
    }

    if (catalogIndex < catalogSongs.length) {
      add(catalogSongs[catalogIndex]);
      catalogIndex += 1;
      continue;
    }

    add(liveSongs[liveIndex]);
    liveIndex += 1;
  }

  for (; result.length < target && liveIndex < liveSongs.length; liveIndex += 1) {
    add(liveSongs[liveIndex]);
  }
  for (; result.length < target && catalogIndex < catalogSongs.length; catalogIndex += 1) {
    add(catalogSongs[catalogIndex]);
  }

  return result;
}

function shapeStationForFreshAir(
  songs: SongRecommendation[],
  target: number
): SongRecommendation[] {
  const liveCandidates = songs.filter(isLiveSourced);
  if (liveCandidates.length === 0) {
    return spreadArtistsForDisplay(songs, target);
  }

  const desiredLiveCount = Math.min(liveCandidates.length, freshAirTarget(target));
  const liveSongs = spreadArtistsForDisplay(liveCandidates, desiredLiveCount);
  const liveKeys = new Set(liveSongs.map(trackIdentity));
  const catalogCandidates = songs.filter((song) => !liveKeys.has(trackIdentity(song)) && !isLiveSourced(song));
  const catalogSongs = spreadArtistsForDisplay(catalogCandidates, Math.max(0, target - liveSongs.length));
  const blended = interleaveFreshAir(catalogSongs, liveSongs, target);

  if (blended.length >= target) return blended;

  const blendedKeys = new Set(blended.map(trackIdentity));
  const fill = spreadArtistsForDisplay(
    songs.filter((song) => !blendedKeys.has(trackIdentity(song))),
    target - blended.length
  );
  return [...blended, ...fill].slice(0, target);
}

function toQueueTracks(songs: SongRecommendation[]): QueueTrack[] {
  return interleaveForPlayback(songs)
    .filter((s) => s.spotify_track_id)
    .map((s) => ({
      spotifyTrackId: s.spotify_track_id,
      trackName: s.track_name,
      artistName: s.artist_name,
    }));
}

function sameWeights(a: Preset["weights"], b: Preset["weights"]): boolean {
  return a.affinity === b.affinity && a.context === b.context && a.editorial === b.editorial;
}

function strategyCacheKey(strategy: TasteStrategy | null): string {
  return strategy ? JSON.stringify(strategy) : "default";
}

function readDiscoverCache(
  prompt: string,
  weights: Preset["weights"],
  strategyKey: string
): SongRecommendation[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(DISCOVER_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as DiscoverCachePayload;
    const fresh = Date.now() - cached.savedAt < DISCOVER_CACHE_TTL_MS;
    if (
      !fresh ||
      cached.prompt !== prompt ||
      !sameWeights(cached.weights, weights) ||
      cached.strategyKey !== strategyKey
    ) {
      return null;
    }
    return Array.isArray(cached.results) ? cached.results : null;
  } catch {
    return null;
  }
}

function writeDiscoverCache(
  prompt: string,
  weights: Preset["weights"],
  strategyKey: string,
  results: SongRecommendation[]
): void {
  if (typeof window === "undefined") return;
  try {
    const payload: DiscoverCachePayload = {
      savedAt: Date.now(),
      prompt,
      weights,
      strategyKey,
      results,
    };
    window.sessionStorage.setItem(DISCOVER_CACHE_KEY, JSON.stringify(payload));
  } catch {
    /* Ignore storage quota/privacy-mode failures. */
  }
}

function toSpotifyTrackUris(trackIdsOrUris: string[]): string[] {
  return trackIdsOrUris
    .filter((id) => typeof id === "string" && id.trim().length > 0)
    .map((id) => (id.startsWith("spotify:track:") ? id : `spotify:track:${id}`));
}

async function getBrowserSpotifyToken(): Promise<string> {
  const tokenRes = await fetch("/api/auth/token", { cache: "no-store" });
  const tokenData = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenData.access_token) {
    throw new Error(
      tokenRes.status === 401
        ? "Spotify session expired. Please sign out and back in."
        : "Could not get a Spotify access token."
    );
  }
  return tokenData.access_token;
}

async function addSpotifyPlaylistTracksFromBrowser(
  playlistId: string,
  trackUris: string[]
): Promise<{ added: number; failed: string[] }> {
  if (!playlistId) throw new Error("Playlist was created without a Spotify ID.");

  let accessToken = await getBrowserSpotifyToken();
  const failed: string[] = [];

  async function addBatch(batch: string[]) {
    return fetch(`https://api.spotify.com/v1/playlists/${playlistId}/items`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ uris: batch }),
    });
  }

  for (let i = 0; i < trackUris.length; i += 100) {
    const batch = trackUris.slice(i, i + 100);
    let addRes = await addBatch(batch);

    if (addRes.status === 401) {
      accessToken = await getBrowserSpotifyToken();
      addRes = await addBatch(batch);
    }

    if (addRes.ok) continue;

    const err = await addRes.json().catch(() => ({}));
    if (addRes.status === 401) {
      throw new Error("Spotify session expired. Please sign out and back in.");
    }
    if (addRes.status === 403) {
      throw new Error(
        err?.error?.message ||
          "Spotify blocked adding tracks to this playlist. Make sure your Spotify account is allowed for this app."
      );
    }

    for (const uri of batch) {
      const singleRes = await addBatch([uri]);
      if (!singleRes.ok) {
        failed.push(uri.replace("spotify:track:", ""));
      }
    }
  }

  return {
    added: trackUris.length - failed.length,
    failed,
  };
}

async function removeSpotifyPlaylistFromBrowser(playlistId: string): Promise<boolean> {
  if (!playlistId) return false;
  try {
    const accessToken = await getBrowserSpotifyToken();
    const res = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/followers`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

function chooseFallbackTracks(tracks: any[]): any[] { // eslint-disable-line @typescript-eslint/no-explicit-any
  const seen = new Set<string>();
  const unique = tracks.filter((track) => {
    const key = `${track?.name ?? ""}|${track?.artists?.[0]?.name ?? ""}`.toLowerCase();
    if (!key.trim() || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Pick a diverse spread across the popularity range so fallbacks
  // include both discoveries and recognisable tracks.
  if (unique.length <= 5) return unique;
  const sorted = [...unique].sort((a, b) => (a.popularity ?? 50) - (b.popularity ?? 50));
  const step = (sorted.length - 1) / 4;
  return [0, 1, 2, 3, 4].map((i) => sorted[Math.round(i * step)]);
}

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

function liveTrackScore(track: any, intentIndex: number, trackIndex: number): number { // eslint-disable-line @typescript-eslint/no-explicit-any
  const popularity = Math.max(0, Math.min(1, (track?.popularity ?? 50) / 100));
  const rankScore = 1 - Math.min(trackIndex, LIVE_EXPANSION_TRACK_LIMIT - 1) / LIVE_EXPANSION_TRACK_LIMIT;
  const intentScore = 1 - Math.min(intentIndex, LIVE_EXPANSION_INTENT_LIMIT - 1) / LIVE_EXPANSION_INTENT_LIMIT;
  const freshness = releaseFreshness(track?.album?.release_date);
  const popularityShape = popularity > 0.78 ? -0.04 : popularity < 0.35 ? 0.07 : 0.04;

  return Number(
    Math.max(
      0.05,
      Math.min(0.92, 0.48 + rankScore * 0.16 + intentScore * 0.08 + freshness * 0.08 + popularityShape)
    ).toFixed(4)
  );
}

function liveTrackToRecommendation(
  track: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  intent: LiveSearchIntent,
  intentIndex: number,
  trackIndex: number,
  hasPrompt: boolean
): SongRecommendation | null {
  const artist = track?.artists?.[0];
  if (!track?.id || !track?.name || !artist?.name) return null;

  const popularity = Math.max(0, Math.min(1, (track.popularity ?? 50) / 100));
  const freshness = releaseFreshness(track.album?.release_date);
  const novelty = Math.max(0.25, Math.min(1, 1 - popularity * 0.55 + freshness * 0.25));
  const score = liveTrackScore(track, intentIndex, trackIndex);
  const recommendation: SongRecommendation = {
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
    novelty_score: novelty,
    familiarity_score: 0,
    signals: {
      affinity: Math.max(0.25, score - 0.14),
      context: hasPrompt ? Math.max(0.25, score - 0.08) : 0.15,
      editorial: 0,
      track_popularity: popularity,
      novelty,
      familiarity: 0,
    },
    genres: [],
    reasons: ["Live Spotify search", intent.label ?? "Outside catalog"],
    mention_count: 0,
    top_mention: null,
  };
  recommendation.lane = laneForSong(recommendation);
  return recommendation;
}

function shouldRunLiveExpansion(
  songs: SongRecommendation[],
  currentPrompt: string,
  strategy: TasteStrategy | null
): boolean {
  if (strategy?.live_expansion === "live" && !currentPrompt.trim()) return true;
  if (!currentPrompt.trim()) return true;
  if (songs.length < TARGET_SONGS) return true;
  if (songs.length < LIVE_EXPANSION_POOL_TARGET) return true;
  if (currentPrompt.trim()) return true;
  return new Set(songs.map((song) => artistIdentity(song))).size < Math.min(20, TARGET_SONGS);
}

async function fetchLiveCandidateSongs(
  currentPrompt: string,
  existingSongs: SongRecommendation[],
  strategy: TasteStrategy | null
): Promise<SongRecommendation[]> {
  if (!shouldRunLiveExpansion(existingSongs, currentPrompt, strategy)) return [];

  const intentRes = await fetch("/api/live-candidate-intents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: currentPrompt || null,
      limit: LIVE_EXPANSION_INTENT_LIMIT,
      taste_strategy: strategy,
    }),
  });
  if (!intentRes.ok) return [];
  const intentData: LiveCandidateIntentsResponse = await intentRes.json().catch(() => ({}));
  const intents = (intentData.intents ?? []).filter((intent) => intent.query?.trim());
  if (intents.length === 0) return [];

  const accessToken = await getBrowserSpotifyToken();
  const spotifyHeaders = { Authorization: `Bearer ${accessToken}` };

  const batches = await Promise.all(
    intents.map(async (intent, intentIndex) => {
      try {
        const searchRes = await fetch(
          `https://api.spotify.com/v1/search?q=${encodeURIComponent(intent.query)}&type=track&market=US&limit=${LIVE_EXPANSION_TRACK_LIMIT}`,
          { headers: spotifyHeaders }
        );
        if (!searchRes.ok) return [];
        const data = await searchRes.json();
        const tracks = chooseFallbackTracks(data.tracks?.items ?? []).slice(0, LIVE_EXPANSION_TRACKS_PER_INTENT);
        return tracks
          .map((track, trackIndex) =>
            liveTrackToRecommendation(track, intent, intentIndex, trackIndex, Boolean(currentPrompt.trim()))
          )
          .filter((song): song is SongRecommendation => Boolean(song));
      } catch {
        return [];
      }
    })
  );

  return batches.flat().sort((a, b) => b.score - a.score);
}

function mergeCandidateSongs(
  baseSongs: SongRecommendation[],
  liveSongs: SongRecommendation[]
): SongRecommendation[] {
  const merged = [...baseSongs];
  const seen = new Set(baseSongs.map(trackIdentity));
  const artistCounts = new Map<string, number>();

  for (const song of baseSongs) {
    const artistKey = artistIdentity(song);
    artistCounts.set(artistKey, (artistCounts.get(artistKey) ?? 0) + 1);
  }

  for (const song of liveSongs) {
    const trackKey = trackIdentity(song);
    if (!trackKey || seen.has(trackKey)) continue;
    const artistKey = artistIdentity(song);
    if ((artistCounts.get(artistKey) ?? 0) >= 2) continue;
    seen.add(trackKey);
    artistCounts.set(artistKey, (artistCounts.get(artistKey) ?? 0) + 1);
    merged.push(song);
  }

  return merged.sort((a, b) => b.score - a.score).slice(0, LIVE_EXPANSION_POOL_TARGET);
}

export default function DiscoverView({
  onNavigate,
  readiness,
}: {
  onNavigate?: (view: string) => void;
  readiness?: RadioReadinessSummary;
}) {
  const { setQueue, playFromQueue } = usePlayer();
  const [prompt, setPrompt] = useState("");
  const [weights, setWeights] = useState(PRESETS[0].weights);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [results, setResults] = useState<SongRecommendation[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingStage, setLoadingStage] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [laneFilter, setLaneFilter] = useState<LaneFilterId>("all");
  const [genreFilter, setGenreFilter] = useState<string>("");
  const [favoritedIds, setFavoritedIds] = useState<Set<string>>(new Set());
  const [feedbackMap, setFeedbackMap] = useState<Record<string, 1 | -1>>({});
  const [playlistState, setPlaylistState] = useState<
    "idle" | "saving" | "done" | "error"
  >("idle");
  const [playlistUrl, setPlaylistUrl] = useState<string | null>(null);
  const [playlistError, setPlaylistError] = useState<string | null>(null);
  const [playlistStats, setPlaylistStats] = useState<{
    added: number;
    failed: string[];
  } | null>(null);
  const [playAllState, setPlayAllState] = useState<"idle" | "loading">("idle");
  const [tasteStrategy, setTasteStrategy] = useState<TasteStrategy | null>(null);
  const [tasteStrategyLoaded, setTasteStrategyLoaded] = useState(false);
  const autoLoadedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/taste-strategy", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setTasteStrategy(data.strategy ?? null);
      })
      .catch(() => {
        if (!cancelled) setTasteStrategy(null);
      })
      .finally(() => {
        if (!cancelled) setTasteStrategyLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-load recommendations on first mount
  useEffect(() => {
    if (!tasteStrategyLoaded) return;
    if (autoLoadedRef.current) return;
    autoLoadedRef.current = true;
    const currentStrategyKey = strategyCacheKey(tasteStrategy);
    const cached = readDiscoverCache(prompt, weights, currentStrategyKey);
    if (cached) {
      setResults(cached);
      setQueue(toQueueTracks(cached));
      void refreshTrackState(cached);
      return;
    }
    handleSubmit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasteStrategyLoaded]);

  async function refreshTrackState(songs: SongRecommendation[]) {
    const trackIds = songs.map((s) => s.spotify_track_id).filter(Boolean);
    if (trackIds.length === 0) {
      setFavoritedIds(new Set());
      setFeedbackMap({});
      return;
    }

    try {
      const stateRes = await fetch(`/api/track-state?ids=${trackIds.join(",")}`);
      const stateData = await stateRes.json().catch(() => ({}));
      setFavoritedIds(new Set(stateData.favorited ?? []));
      setFeedbackMap(stateData.feedback ?? {});
    } catch {}
  }

  async function handleSubmit() {
    setLoading(true);
    setError(null);
    setLaneFilter("all");
    setGenreFilter("");
    setPlayAllState("idle");
    setPlaylistState("idle");
    setPlaylistUrl(null);
    setPlaylistError(null);
    setPlaylistStats(null);
    try {
      const normalized = {
        affinity: weights.affinity / 100,
        context: weights.context / 100,
        editorial: weights.editorial / 100,
      };
      const currentStrategyKey = strategyCacheKey(tasteStrategy);

      // Try DB-based song recommendations first (faster, better ranking)
      // Falls back to client-side Spotify Search if DB has no tracks
      setLoadingStage("Finding songs for you\u2026");

      let deduped: SongRecommendation[] = [];
      let interpretedPrompt = prompt.trim();

      // Attempt 1: Server-side song recommendations (uses tracks in DB)
      let dbError: string | null = null;
      try {
        const songRes = await fetch(`/api/recommend-songs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: prompt || null,
            weights: normalized,
            limit: 30,
            exclude_library: true,
            discover_run_id: crypto.randomUUID(),
            exclude_previously_shown: true,
            history_window_runs: 15,
            max_allowed_overlap: 0,
            novelty_mode: "strict",
            taste_strategy: prompt.trim() ? null : tasteStrategy,
          }),
        });
        if (songRes.ok) {
          const songData = await songRes.json().catch(() => ({}));
          interpretedPrompt = songData.query_intent?.search_phrase || interpretedPrompt;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          deduped = (songData.results ?? []).map((r: any): SongRecommendation => ({
            track_id: r.track_id ?? null,
            track_name: r.track_name ?? "",
            artist_id: r.artist_id ?? "",
            artist_name: r.artist_name ?? "",
            album_name: r.album_name ?? "",
            release_date: r.release_date ?? null,
            duration_ms: r.duration_ms ?? 0,
            explicit: r.explicit ?? false,
            spotify_track_id: r.spotify_track_id ?? "",
            score: r.score ?? 0,
            lane: r.lane,
            novelty_score: r.novelty_score,
            familiarity_score: r.familiarity_score,
            signals: {
              affinity: r.signals?.affinity ?? 0,
              context: r.signals?.context ?? 0,
              editorial: r.signals?.editorial ?? 0,
              track_popularity: r.signals?.track_popularity,
              novelty: r.signals?.novelty,
              familiarity: r.signals?.familiarity,
            },
            genres: r.genres ?? [],
            reasons: r.reasons ?? [],
            mention_count: r.mention_count ?? 0,
            top_mention: r.top_mention
              ? {
                  source: r.top_mention.source ?? "",
                  source_url: r.top_mention.source_url ?? "",
                  article_url: r.top_mention.article_url ?? "",
                  excerpt: r.top_mention.excerpt ?? "",
                  published_at: r.top_mention.published_at ?? "",
                }
              : null,
          }));
        }
      } catch (e) {
        dbError = e instanceof Error ? e.message : "Request timed out";
        console.warn("recommend-songs failed, falling back to Spotify search:", e);
      }

      // Attempt 2: Supplement with real-time Spotify Search
      // If DB returned fewer than the target, fill remaining slots with live
      // Spotify results from high-scoring artists. This also runs as a full
      // fallback when the DB has no songs at all.
      if (deduped.length < TARGET_SONGS) {
        setLoadingStage(
          deduped.length > 0
            ? `Found ${deduped.length} songs, searching Spotify for more\u2026`
            : "Searching Spotify for songs\u2026"
        );
        const artistRes = await fetch(`/api/recommend`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: interpretedPrompt || prompt || null,
            weights: normalized,
            limit: 25,  // Request extra to allow diversity filtering
          }),
        });
        const artistData = await artistRes.json().catch(() => ({}));
        if (!artistRes.ok) {
          setError(artistData.error ?? artistData.detail ?? "Failed to get recommendations");
          setResults([]);
          return;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const artists: any[] = artistData.results ?? [];
        if (artists.length === 0 && deduped.length === 0) {
          if (dbError) {
            setError(`Could not load recommendations (${dbError}). Please try again.`);
          } else {
            setError("No recommendations found. Try a different search or adjust your weights.");
          }
          setResults([]);
          return;
        }

        const tokenRes = await fetch("/api/auth/token");
        const tokenData = await tokenRes.json().catch(() => ({}));
        const accessToken = tokenData.access_token;

        if (!accessToken) {
          if (deduped.length > 0) {
            setResults(deduped);
            writeDiscoverCache(prompt, weights, currentStrategyKey, deduped);
            setQueue(toQueueTracks(deduped));
            void refreshTrackState(deduped);
            return;
          }
          setError("Spotify session expired and no tracks in catalog \u2014 please sign out and back in, then re-run 'Set up music profile'");
          setResults([]);
          return;
        }

        setLoadingStage("Fetching songs from Spotify\u2026");
        const spotifyHeaders = { Authorization: `Bearer ${accessToken}` };
        // Only search for artists we don't already have songs for from DB results
        const existingArtists = new Set(deduped.map(s => s.artist_name.toLowerCase()));
        const missingArtists = artists.filter((a: any) => !existingArtists.has(a.artist_name.toLowerCase())); // eslint-disable-line @typescript-eslint/no-explicit-any
        const songArrays = await Promise.all(
          missingArtists.slice(0, FALLBACK_ARTIST_SEARCH_LIMIT).map(async (artist: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
            try {
              const queries = interpretedPrompt
                ? [
                    `artist:${artist.artist_name} ${interpretedPrompt}`,
                    `artist:${artist.artist_name}`,
                  ]
                : [`artist:${artist.artist_name}`];
              let searchData: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
              for (const q of queries) {
                const searchRes = await fetch(
                  `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&market=US&limit=${FALLBACK_TRACK_SEARCH_LIMIT}`,
                  { headers: spotifyHeaders }
                );
                if (!searchRes.ok) continue;
                const data = await searchRes.json();
                if ((data.tracks?.items ?? []).length > 0) {
                  searchData = data;
                  break;
                }
              }
              if (!searchData) return [];
              const tracks = chooseFallbackTracks(searchData.tracks?.items ?? []);

              return tracks.map((track: any): SongRecommendation => { // eslint-disable-line @typescript-eslint/no-explicit-any
                const trackPop = (track.popularity ?? 50) / 100;
                const depthBoost = trackPop < 0.46 ? 1.08 : trackPop > 0.74 ? 0.88 : 1.0;
                const songScore = artist.score * (0.78 + 0.18 * trackPop) * depthBoost;
                const fallbackSong: SongRecommendation = {
                  track_id: null,
                  track_name: track.name,
                  artist_id: artist.artist_id,
                  artist_name: track.artists?.[0]?.name ?? artist.artist_name,
                  album_name: track.album?.name ?? "",
                  release_date: track.album?.release_date ?? null,
                  duration_ms: track.duration_ms ?? 0,
                  explicit: track.explicit ?? false,
                  spotify_track_id: track.id,
                  score: songScore,
                  novelty_score: 1.0,
                  familiarity_score: 0.0,
                  signals: {
                    affinity: artist.signals.affinity,
                    context: artist.signals.context,
                    editorial: artist.signals.editorial,
                    track_popularity: trackPop,
                    novelty: Math.max(0, Math.min(1, 1 - trackPop + (artist.signals.editorial ?? 0) * 0.2)),
                  },
                  genres: artist.genres ?? [],
                  reasons: [...(artist.reasons ?? [])],
                  mention_count: artist.mention_count ?? 0,
                  top_mention: artist.top_mention ?? null,
                };
                fallbackSong.lane = laneForSong(fallbackSong);
                return fallbackSong;
              });
            } catch {
              return [];
            }
          })
        );

        const allSongs = songArrays.flat();
        allSongs.sort((a, b) => b.score - a.score);

        // Build dedup sets from existing DB results so we don't duplicate
        const seen = new Set<string>();
        const artistCounts: Record<string, number> = {};
        for (const existing of deduped) {
          const key = `${existing.track_name.toLowerCase()}|${existing.artist_name.toLowerCase()}`;
          seen.add(key);
          const ak = existing.artist_name.toLowerCase();
          artistCounts[ak] = (artistCounts[ak] ?? 0) + 1;
        }

        for (const song of allSongs) {
          const key = `${song.track_name.toLowerCase()}|${song.artist_name.toLowerCase()}`;
          if (seen.has(key)) continue;
          const ak = song.artist_name.toLowerCase();
          if ((artistCounts[ak] ?? 0) >= 2) continue;
          seen.add(key);
          artistCounts[ak] = (artistCounts[ak] ?? 0) + 1;
          deduped.push(song);
          if (deduped.length >= TARGET_SONGS) break;
        }
      }

      try {
        const livePrompt = interpretedPrompt || prompt;
        if (shouldRunLiveExpansion(deduped, livePrompt, tasteStrategy)) {
          setLoadingStage("Expanding live search beyond the catalog\u2026");
          const liveSongs = await fetchLiveCandidateSongs(livePrompt, deduped, tasteStrategy);
          if (liveSongs.length > 0) {
            deduped = mergeCandidateSongs(deduped, liveSongs);
          }
        }
      } catch (e) {
        console.warn("live candidate expansion failed:", e);
      }

      if (deduped.length === 0) {
        setError(
          dbError
            ? `Could not load recommendations (${dbError}). Please try again.`
            : "No recommendations found — try a different search or adjust your weights."
        );
      }
      const finalResults = shapeStationForFreshAir(deduped, TARGET_SONGS);

      setResults(finalResults);
      writeDiscoverCache(prompt, weights, currentStrategyKey, finalResults);

      // Set the player queue so songs auto-advance
      setQueue(toQueueTracks(finalResults));

      // Fetch initial favorite and feedback state
      await refreshTrackState(finalResults);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setResults([]);
    } finally {
      setLoading(false);
      setLoadingStage("");
    }
  }

  async function playSongs(songs: SongRecommendation[]) {
    const tracks = songs.filter((s) => s.spotify_track_id);
    if (tracks.length === 0) return;

    const qTracks: QueueTrack[] = tracks.map((s) => ({
      spotifyTrackId: s.spotify_track_id,
      trackName: s.track_name,
      artistName: s.artist_name,
    }));
    setQueue(qTracks);
    await playFromQueue(0);
  }

  async function handlePlayAll(songs: SongRecommendation[]) {
    if (playAllState === "loading") return;
    setPlayAllState("loading");
    try {
      await playSongs(songs);
    } finally {
      setPlayAllState("idle");
    }
  }

  async function handleSavePlaylist() {
    if (!results || results.length === 0) return;
    setPlaylistState("saving");
    setPlaylistError(null);
    setPlaylistUrl(null);
    setPlaylistStats(null);
    try {
      const now = new Date();
      const dateStr = now.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
      const name = prompt
        ? `MusicLife: ${prompt.slice(0, 40)}${prompt.length > 40 ? "\u2026" : ""}`
        : `MusicLife Discover \u2014 ${dateStr}`;
      const description = prompt
        ? `"${prompt}" \u2014 Personalized by MusicLife on ${dateStr}`
        : `Personalized discovery playlist by MusicLife \u2014 ${dateStr}`;

      // Collect Spotify track IDs directly — no re-searching needed
      const trackIds = results
        .map((r) => r.spotify_track_id)
        .filter(Boolean);

      if (trackIds.length === 0) {
        setPlaylistState("error");
        setPlaylistError("No songs with valid Spotify IDs to save");
        return;
      }

      const res = await fetch("/api/playlist-from-tracks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ track_ids: trackIds, name, description }),
      });
      const data: PlaylistCreateResponse = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPlaylistState("error");
        const errMsg = data.error ?? `Failed to create playlist (HTTP ${res.status})`;
        if (res.status === 403) {
          setPlaylistError("Missing Spotify permissions — reconnecting...");
          // Auto-redirect to force re-auth with updated scopes
          setTimeout(() => {
            window.location.href = "/api/auth/login?force=1";
          }, 1500);
        } else {
          setPlaylistError(
            res.status === 401
              ? "Spotify session expired. Please sign out and back in."
              : errMsg
          );
        }
        return;
      }

      if (!data.playlist_id) {
        setPlaylistState("error");
        setPlaylistError("Spotify created a playlist response without an ID. Please try again.");
        return;
      }

      const trackUris = Array.isArray(data.track_uris) && data.track_uris.length > 0
        ? data.track_uris
        : toSpotifyTrackUris(trackIds);
      let added = data.tracks_added ?? 0;
      let failed = data.tracks_failed ?? [];

      if (data.add_tracks_client_side || added === 0) {
        try {
          const clientAdd = await addSpotifyPlaylistTracksFromBrowser(data.playlist_id, trackUris);
          added = clientAdd.added;
          failed = clientAdd.failed;
        } catch (addErr) {
          const removedEmptyPlaylist = await removeSpotifyPlaylistFromBrowser(data.playlist_id);
          setPlaylistState("error");
          setPlaylistUrl(removedEmptyPlaylist ? null : data.playlist_url ?? null);
          const baseMessage =
            addErr instanceof Error
              ? addErr.message
              : data.server_add_error || "Spotify refused the playlist item update.";
          setPlaylistError(
            removedEmptyPlaylist
              ? `Spotify refused adding tracks, so the empty playlist was removed. ${baseMessage}`
              : `Playlist was created, but tracks could not be added. ${baseMessage}`
          );
          return;
        }
      }

      setPlaylistState("done");
      setPlaylistUrl(data.playlist_url ?? null);
      setPlaylistStats({
        added,
        failed,
      });
    } catch (err) {
      setPlaylistState("error");
      setPlaylistError(
        err instanceof Error ? err.message : "Network error"
      );
    }
  }

  const queueSongs = results ? interleaveForPlayback(results) : [];
  const allGenres = results
    ? Array.from(new Set(results.flatMap((r) => r.genres.map((g) => g.toLowerCase())))).sort()
    : [];
  const laneSongs =
    laneFilter === "all"
      ? queueSongs
      : queueSongs.filter((song) => laneForSong(song) === laneFilter);
  const displayed = genreFilter
    ? laneSongs.filter((r) => r.genres.some((g) => g.toLowerCase() === genreFilter))
    : laneSongs;
  const playableCount = displayed.filter((s) => s.spotify_track_id).length;
  const mix = results ? stationMixSummary(results, prompt, weights) : null;

  return (
    <div className="max-w-6xl space-y-4">
      <section className="overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm shadow-neutral-100/70">
        <div className="border-b border-neutral-100 bg-neutral-50/70 px-4 py-3 sm:px-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-emerald-600">
                MusicLife Radio
              </p>
              <h3 className="mt-1 text-xl font-semibold tracking-tight text-neutral-950">
                Tune a station, then listen in order.
              </h3>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-neutral-500">
                Build a queue from your taste, live Spotify search, and current music context.
              </p>
            </div>
            {readiness && (
              <div className="space-y-2 sm:min-w-[320px]">
                <div className="grid grid-cols-3 gap-2 text-center">
                  <StationMetric value={readiness.artistCount} label="taste artists" />
                  <StationMetric value={readiness.embeddedCount} label="modeled" />
                  <StationMetric value={readiness.playableTrackCount} label="catalog tracks" />
                </div>
                <div className="flex items-center justify-center gap-1.5 rounded-full border border-emerald-100 bg-emerald-50 px-3 py-1 text-[11px] font-medium text-emerald-700">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
                  Outside air {tasteStrategy?.live_expansion ?? "auto"}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="space-y-3 p-4 sm:p-5">
          <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto]">
            <input
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              placeholder="Describe a sound, scene, mood, or reference..."
              className="min-h-[42px] w-full rounded-lg border border-neutral-200 px-4 py-2.5 text-sm placeholder:text-neutral-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
            <div className="grid grid-cols-2 gap-2 sm:flex">
              <button
                onClick={handleSubmit}
                disabled={loading}
                className="inline-flex min-h-[42px] items-center justify-center gap-2 rounded-lg bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white transition-all hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? (
                  <>
                    <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <circle cx="12" cy="12" r="10" strokeOpacity="0.3" />
                      <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
                    </svg>
                    {loadingStage || "Finding..."}
                  </>
                ) : results ? (
                  "Retune"
                ) : (
                  "Discover"
                )}
              </button>
              <button
                onClick={() => void handlePlayAll(displayed)}
                disabled={playAllState === "loading" || playableCount === 0}
                className="inline-flex min-h-[42px] items-center justify-center gap-2 rounded-lg border border-neutral-200 bg-white px-4 py-2.5 text-sm font-medium text-neutral-800 transition-all hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40"
                title={
                  playableCount > 0
                    ? `Play ${playableCount} songs from this station view`
                    : "No playable Spotify tracks in this view"
                }
              >
                {playAllState === "loading" ? (
                  <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <circle cx="12" cy="12" r="10" strokeOpacity="0.3" />
                    <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
                  </svg>
                ) : (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
                {playAllState === "loading" ? "Starting" : "Play station"}
              </button>
              <div className="col-span-2 sm:col-span-1">
                <SavePlaylistButton
                  state={playlistState}
                  count={results?.length ?? 0}
                  onSave={handleSavePlaylist}
                />
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {PRESETS.map((p) => {
              const isSearchMode = p.label === "Match Search";
              const unavailable = isSearchMode && !prompt;
              const active = sameWeights(weights, p.weights);
              return (
                <button
                  key={p.label}
                  onClick={() => { if (!unavailable) setWeights(p.weights); }}
                  disabled={unavailable}
                  title={unavailable ? "Enter a search prompt above to use this mode" : p.desc}
                  className={[
                    "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                    active
                      ? "border-neutral-900 bg-neutral-900 text-white"
                      : unavailable
                      ? "cursor-not-allowed border-neutral-200 bg-white text-neutral-300"
                      : "border-neutral-200 bg-white text-neutral-600 hover:border-emerald-300 hover:text-emerald-700",
                  ].join(" ")}
                >
                  {p.label}
                </button>
              );
            })}
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="ml-auto text-[11px] text-neutral-400 hover:text-neutral-600"
            >
              {showAdvanced ? "Hide sliders" : "Fine-tune"}
            </button>
          </div>

          {showAdvanced && (
            <div className="space-y-3 rounded-lg border border-neutral-100 bg-neutral-50/60 px-3 pb-3 pt-2">
              <div className="grid gap-4 sm:grid-cols-3">
                <WeightSlider
                  label="Taste"
                  hint="Similarity to your saved listening history"
                  value={weights.affinity}
                  onChange={(v) => setWeights({ ...weights, affinity: v })}
                />
                <WeightSlider
                  label="Search Match"
                  hint={prompt ? "How closely songs match your typed prompt" : "Enter a prompt above; this signal is inactive without one"}
                  value={weights.context}
                  dimmed={!prompt}
                  onChange={(v) => setWeights({ ...weights, context: v })}
                />
                <WeightSlider
                  label="Buzz"
                  hint="Artists with recent press coverage"
                  value={weights.editorial}
                  onChange={(v) => setWeights({ ...weights, editorial: v })}
                />
              </div>
              <p className="text-[10px] leading-relaxed text-neutral-400">
                Retuning reshuffles the station. Songs you already saved are ranked lower.
              </p>
            </div>
          )}
        </div>
      </section>

      {/* Loading stage indicator */}
      {loading && loadingStage && (
        <div className="flex items-center gap-2 text-sm text-neutral-500">
          <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <circle cx="12" cy="12" r="10" strokeOpacity="0.3" />
            <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
          </svg>
          {loadingStage}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="border border-red-200 bg-red-50 text-red-700 rounded-lg p-3 text-sm flex items-center justify-between gap-3">
          <span>{error}</span>
          <button
            onClick={handleSubmit}
            className="shrink-0 px-3 py-1.5 rounded-lg border border-red-200 text-red-600 text-xs font-medium hover:bg-red-100 transition-colors"
          >
            Try again
          </button>
        </div>
      )}

      {/* Results */}
      {results === null && !loading ? (
        <EmptyInitial />
      ) : results !== null && results.length === 0 && !error ? (
        <EmptyNoResults />
      ) : results !== null && results.length > 0 ? (
        <div className="space-y-3">
          {mix && <StationMixStrip mix={mix} />}

          {/* Playlist success banner */}
          {playlistState === "done" && playlistUrl && (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-emerald-800">
                  Playlist created!
                  {playlistStats && (
                    <span className="font-normal text-emerald-600">
                      {" "}
                      — {playlistStats.added} track
                      {playlistStats.added !== 1 ? "s" : ""} added
                      {playlistStats.failed.length > 0 && (
                        <>, {playlistStats.failed.length} skipped</>
                      )}
                    </span>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {onNavigate && (
                  <button
                    onClick={() => onNavigate("playlists")}
                    className="px-3 py-1.5 rounded-lg border border-emerald-200 text-emerald-700 text-xs font-medium hover:bg-emerald-100 transition-colors"
                  >
                    View in Playlists \u2192
                  </button>
                )}
                <a
                  href={playlistUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-1.5 rounded-lg bg-[#1DB954] text-white text-xs font-medium hover:bg-[#1aa34a] transition-colors flex items-center gap-1.5"
                >
                  <SpotifyIcon size={14} />
                  Open saved playlist
                </a>
              </div>
            </div>
          )}

          {/* Playlist error banner */}
          {playlistState === "error" && playlistError && (
            <div className="border border-red-200 bg-red-50 rounded-lg px-3 py-2 flex items-center gap-2">
              <span
                aria-hidden="true"
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-red-300 text-[11px] font-semibold text-red-600"
              >
                !
              </span>
              <p className="text-xs text-red-700 flex-1">{playlistError}</p>
              {playlistUrl && (
                <a
                  href={playlistUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 px-3 py-1.5 rounded-lg border border-red-200 text-red-600 text-xs font-medium hover:bg-red-100 transition-colors"
                >
                  Open playlist
                </a>
              )}
              <button
                onClick={() => {
                  setPlaylistState("idle");
                  setPlaylistError(null);
                }}
                className="text-xs text-red-400 hover:text-red-600"
              >
                x
              </button>
            </div>
          )}

          <section className="overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm shadow-neutral-100/70">
            <div className="flex flex-col gap-3 border-b border-neutral-100 bg-neutral-50/70 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-semibold text-neutral-950">Station Queue</h3>
                  <span className="rounded-full bg-white px-2 py-0.5 text-[11px] tabular-nums text-neutral-500 ring-1 ring-neutral-200">
                    {displayed.length}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-neutral-500">
                  {laneLabel(laneFilter)}
                  {genreFilter ? `, ${genreFilter}` : ""} in play order
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex rounded-lg border border-neutral-200 bg-white p-0.5">
                  {LANE_FILTERS.map((filter) => (
                    <button
                      key={filter.id}
                      onClick={() => setLaneFilter(filter.id)}
                      className={[
                        "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                        laneFilter === filter.id
                          ? "bg-neutral-900 text-white"
                          : "text-neutral-500 hover:bg-neutral-50 hover:text-neutral-800",
                      ].join(" ")}
                    >
                      {filter.label}
                    </button>
                  ))}
                </div>
                {allGenres.length > 1 && (
                  <select
                    value={genreFilter}
                    onChange={(e) => setGenreFilter(e.target.value)}
                    className="min-h-[32px] rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs text-neutral-600 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    aria-label="Filter by genre"
                  >
                    <option value="">All genres</option>
                    {allGenres.map((g) => (
                      <option key={g} value={g}>{g}</option>
                    ))}
                  </select>
                )}
              </div>
            </div>

            {displayed.length > 0 ? (
              <div className="divide-y divide-neutral-100">
                {displayed.map((song, i) => (
                  <SongRow
                    key={`${song.spotify_track_id || song.track_name}-${i}`}
                    song={song}
                    rank={i + 1}
                    initialFavorited={favoritedIds.has(song.spotify_track_id)}
                    initialFeedback={feedbackMap[song.spotify_track_id] ?? null}
                    currentPrompt={prompt}
                  />
                ))}
              </div>
            ) : (
              <div className="px-4 py-12 text-center">
                <p className="text-sm font-medium text-neutral-700">No songs in this view</p>
                <p className="mt-1 text-xs text-neutral-400">
                  Try All lanes or clear the genre filter.
                </p>
              </div>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}

function StationMetric({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-md border border-neutral-200 bg-white px-3 py-2">
      <div className="text-sm font-semibold tabular-nums text-neutral-950">
        {value.toLocaleString()}
      </div>
      <div className="text-[10px] leading-tight text-neutral-400">{label}</div>
    </div>
  );
}

function StationMixStrip({
  mix,
}: {
  mix: ReturnType<typeof stationMixSummary>;
}) {
  const sourceTotal = Math.max(1, mix.catalogCount + mix.liveCount);
  const laneTotal = Math.max(
    1,
    mix.laneCounts.deep_cuts + mix.laneCounts.popular + mix.laneCounts.radio_hits
  );

  return (
    <section className="rounded-lg border border-neutral-200 bg-white px-4 py-3 shadow-sm shadow-neutral-100/70">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-neutral-950">Station Mix</h3>
            <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-500">
              {mix.presetLabel}
            </span>
            <span className="truncate rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">
              {mix.promptLabel}
            </span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-neutral-500">
            {mix.total} songs: {mix.catalogCount} catalog-ranked and {mix.liveCount} outside-air Spotify sourced.
          </p>
          <p className="mt-1 text-xs leading-relaxed text-neutral-400">
            {mix.sourceInsight}
          </p>
        </div>

        <div className="grid gap-3 xl:min-w-[560px]">
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-neutral-400">
              Source mix
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <MixTile
                label="Catalog-ranked"
                value={mix.catalogCount}
                pct={mix.catalogCount / sourceTotal}
                tone="bg-neutral-800"
              />
              <MixTile
                label="Outside air"
                value={mix.liveCount}
                pct={mix.liveCount / sourceTotal}
                tone="bg-emerald-500"
                hint={
                  mix.liveCount === 0
                    ? "Why 0? MusicLife tried to reserve fresh air, but no usable live Spotify candidates were available for this run."
                    : "Tracks found from live Spotify search outside the modeled catalog."
                }
              />
            </div>
          </div>

          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-neutral-400">
              Discovery balance
            </p>
            <div className="grid gap-2 sm:grid-cols-3">
              <MixTile
                label="Deep cuts"
                value={mix.laneCounts.deep_cuts}
                pct={mix.laneCounts.deep_cuts / laneTotal}
                tone="bg-violet-500"
              />
              <MixTile
                label="Popular"
                value={mix.laneCounts.popular}
                pct={mix.laneCounts.popular / laneTotal}
                tone="bg-amber-500"
              />
              <MixTile
                label="Radio hits"
                value={mix.laneCounts.radio_hits}
                pct={mix.laneCounts.radio_hits / laneTotal}
                tone="bg-emerald-500"
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function MixTile({
  label,
  value,
  pct,
  tone,
  hint,
}: {
  label: string;
  value: number;
  pct: number;
  tone: string;
  hint?: string;
}) {
  return (
    <div className="rounded-md border border-neutral-100 bg-neutral-50 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-neutral-500">{label}</span>
        <span className="text-[11px] font-semibold tabular-nums text-neutral-800">{value}</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-neutral-200">
        <div
          className={`h-full rounded-full ${tone}`}
          style={{ width: value === 0 ? "0%" : `${Math.max(4, Math.round(pct * 100))}%` }}
        />
      </div>
      {hint && (
        <p className="mt-1.5 text-[10px] leading-snug text-neutral-400">{hint}</p>
      )}
    </div>
  );
}

/* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
/*  Discovery Columns                                             */
/* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */

function DiscoveryColumn({
  lane,
  songs,
  favoritedIds,
  feedbackMap,
  currentPrompt,
  onPlayColumn,
}: {
  lane: DiscoveryLane;
  songs: SongRecommendation[];
  favoritedIds: Set<string>;
  feedbackMap: Record<string, 1 | -1>;
  currentPrompt: string;
  onPlayColumn: (songs: SongRecommendation[]) => void;
}) {
  return (
    <section className="min-w-0 border border-neutral-200 rounded-lg overflow-hidden bg-white shadow-sm shadow-neutral-100/70">
      <div className="flex items-start justify-between gap-3 px-4 py-3.5 border-b border-neutral-100 bg-neutral-50/70">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-neutral-900 truncate">
              {lane.title}
            </h3>
            <span className="text-xs tabular-nums text-neutral-400">
              {songs.length}
            </span>
          </div>
          <p className="text-xs text-neutral-500 mt-0.5 truncate">
            {lane.subtitle}
          </p>
        </div>
        <button
          onClick={() => onPlayColumn(songs)}
          disabled={songs.length === 0}
          className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center bg-neutral-900 text-white hover:bg-neutral-700 active:scale-95 transition-all disabled:opacity-25 disabled:cursor-not-allowed"
          title={`Play ${lane.title}`}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        </button>
      </div>

      {songs.length > 0 ? (
        <div className="divide-y divide-neutral-100">
          {songs.map((song, i) => (
            <SongRow
              key={`${lane.id}-${song.spotify_track_id || song.track_name}-${i}`}
              song={song}
              rank={i + 1}
              initialFavorited={favoritedIds.has(song.spotify_track_id)}
              initialFeedback={feedbackMap[song.spotify_track_id] ?? null}
              currentPrompt={currentPrompt}
              compact
            />
          ))}
        </div>
      ) : (
        <div className="px-4 py-10 text-center">
          <p className="text-xs text-neutral-400">
            No matches in this lane yet.
          </p>
        </div>
      )}
    </section>
  );
}

/*  Song Row                                                      */

function SongRow({
  song,
  rank,
  initialFavorited = false,
  initialFeedback = null,
  currentPrompt = "",
  compact = false,
}: {
  song: SongRecommendation;
  rank: number;
  initialFavorited?: boolean;
  initialFeedback?: 1 | -1 | null;
  currentPrompt?: string;
  compact?: boolean;
}) {
  const { playSingle, playFromQueue, queue } = usePlayer();
  const [playState, setPlayState] = useState<"idle" | "loading">("idle");
  const [favorited, setFavorited] = useState(initialFavorited);
  const [favLoading, setFavLoading] = useState(false);
  const [feedback, setFeedback] = useState<1 | -1 | null>(initialFeedback);
  const [fbLoading, setFbLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const matchPct = Math.round(song.score * 100);
  const lane = laneBadge(song);
  const explanation = buildWhyExplanation(song, currentPrompt);
  const minutes = Math.floor(song.duration_ms / 60000);
  const seconds = Math.floor((song.duration_ms % 60000) / 1000);
  const duration =
    song.duration_ms > 0
      ? `${minutes}:${seconds.toString().padStart(2, "0")}`
      : "";

  async function handlePlay() {
    if (!song.spotify_track_id) return;
    setPlayState("loading");
    try {
      const queueIdx = queue.findIndex(t => t.spotifyTrackId === song.spotify_track_id);
      if (queueIdx >= 0) {
        await playFromQueue(queueIdx);
      } else {
        await playSingle({
          spotifyTrackId: song.spotify_track_id,
          trackName: song.track_name,
          artistName: song.artist_name,
        });
      }
    } finally {
      setPlayState("idle");
    }
  }

  async function handleFeedback(value: 1 | -1) {
    if (fbLoading || !song.spotify_track_id) return;
    setFbLoading(true);
    try {
      if (feedback === value) {
        const res = await fetch("/api/feedback", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ spotify_track_id: song.spotify_track_id }),
        });
        if (res.ok) setFeedback(null);
      } else {
        const res = await fetch("/api/feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            spotify_track_id: song.spotify_track_id,
            feedback: value,
            track_name: song.track_name,
            artist_name: song.artist_name,
            score: song.score,
            prompt: currentPrompt || undefined,
            source: "discover",
          }),
        });
        if (res.ok) setFeedback(value);
      }
    } catch {}
    setFbLoading(false);
  }

  return (
    <div className="group">
      <div
        className={[
          compact
            ? "grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 px-4 py-3.5 hover:bg-neutral-50 transition-colors"
            : "flex items-start gap-3 px-4 py-3.5 hover:bg-neutral-50 transition-colors",
        ].join(" ")}
      >
        {/* Rank — hidden on mobile */}
        <span className={["text-right text-xs tabular-nums text-neutral-300 font-medium shrink-0", compact ? "hidden" : "hidden sm:block w-6 pt-3"].join(" ")}>
          {rank}
        </span>

        {/* Play button — primary action, left side for thumb reach */}
        <button
          onClick={handlePlay}
          disabled={playState === "loading"}
          title={`Play ${song.track_name}`}
          className={[
            "shrink-0 rounded-full flex items-center justify-center bg-neutral-900 text-white hover:bg-neutral-700 active:scale-95 transition-all disabled:opacity-40",
            compact ? "w-10 h-10" : "w-11 h-11",
          ].join(" ")}
        >
          {playState === "loading" ? (
            <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <circle cx="12" cy="12" r="10" strokeOpacity="0.3" />
              <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
            </svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

        {/* Song info */}
        <div className={["min-w-0", compact ? "pt-0.5" : "flex-1"].join(" ")}>
          <div className="flex items-center gap-1.5">
            <span
              className={[
                "text-neutral-900",
                compact
                  ? "block text-sm font-semibold leading-snug line-clamp-2 break-words"
                  : "block text-sm font-semibold leading-snug line-clamp-2 break-words",
              ].join(" ")}
            >
              {song.track_name}
            </span>
            {song.explicit && (
              <span className="shrink-0 text-[9px] font-bold bg-neutral-200 text-neutral-500 rounded px-1 py-0.5 leading-none">
                E
              </span>
            )}
          </div>
          <p className="text-[11px] text-neutral-500 truncate mt-0.5">
            {song.artist_name}
            {song.album_name && (
              <span className="text-neutral-400 hidden sm:inline"> &middot; {song.album_name}</span>
            )}
          </p>
          <p
            className={[
              "text-[10px] text-neutral-400 mt-1 leading-snug",
              compact ? "line-clamp-2" : "truncate",
            ].join(" ")}
            title={explanation.summary}
          >
            Why: {explanation.summary}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {lane && (
              <span className={`inline-block text-[9px] font-medium rounded-full px-1.5 py-0.5 ${lane.className}`}>
                {lane.label}
              </span>
            )}
            {isLiveSourced(song) ? (
              <span className="inline-block rounded-full bg-blue-50 px-1.5 py-0.5 text-[9px] font-medium text-blue-600">
                Live Spotify
              </span>
            ) : (
              <span className="inline-block rounded-full bg-neutral-100 px-1.5 py-0.5 text-[9px] font-medium text-neutral-500">
                Catalog-ranked
              </span>
            )}
            {song.top_mention?.source && (
              <SourceBadge mention={song.top_mention} />
            )}
          </div>
        </div>

        {/* Duration — desktop only */}
        {duration && !compact && (
          <span className="shrink-0 text-[11px] tabular-nums text-neutral-300 hidden md:block">
            {duration}
          </span>
        )}

        {/* Match score badge */}
        <div
          className={[
            "shrink-0 rounded-full flex items-center justify-center text-[10px] font-bold",
            compact ? "w-9 h-9 text-xs" : "w-10 h-10 text-xs",
          ].join(" ")}
          style={{
            background:
              matchPct > 70
                ? "linear-gradient(135deg, #059669, #10b981)"
                : matchPct > 40
                ? "linear-gradient(135deg, #d97706, #f59e0b)"
                : "linear-gradient(135deg, #9ca3af, #d1d5db)",
            color: matchPct > 40 ? "white" : "#374151",
          }}
          title={`Match score: ${matchPct}%`}
        >
          {matchPct}
        </div>

        {/* Action buttons — compact group */}
        <div
          className={[
            "flex items-center gap-0 shrink-0",
            compact
              ? "col-start-2 col-span-2 row-start-2 justify-self-start"
              : "rounded-full border border-neutral-100 bg-neutral-50 px-1 py-0.5",
          ].join(" ")}
        >
          {/* Thumbs up */}
          <button
            onClick={() => handleFeedback(1)}
            disabled={fbLoading || !song.spotify_track_id}
            title="More like this"
            className={`w-7 h-7 rounded-full flex items-center justify-center transition-all active:scale-90 disabled:opacity-30 ${
              feedback === 1
                ? "text-emerald-500"
                : "text-neutral-300 hover:text-neutral-500"
            }`}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill={feedback === 1 ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z" />
              <path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
            </svg>
          </button>

          {/* Thumbs down */}
          <button
            onClick={() => handleFeedback(-1)}
            disabled={fbLoading || !song.spotify_track_id}
            title="Less like this"
            className={`w-7 h-7 rounded-full flex items-center justify-center transition-all active:scale-90 disabled:opacity-30 ${
              feedback === -1
                ? "text-red-400"
                : "text-neutral-300 hover:text-neutral-500"
            }`}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill={feedback === -1 ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z" />
              <path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17" />
            </svg>
          </button>

          {/* Favorite (heart) */}
          <button
            onClick={async () => {
              if (favLoading || !song.spotify_track_id) return;
              setFavLoading(true);
              try {
                const method = favorited ? "DELETE" : "POST";
                const res = await fetch("/api/favorite", {
                  method,
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    spotify_track_id: song.spotify_track_id,
                    track_name: song.track_name,
                    artist_name: song.artist_name,
                    score: song.score,
                    source: "discover",
                  }),
                });
                if (res.ok) setFavorited(!favorited);
              } catch {}
              setFavLoading(false);
            }}
            disabled={favLoading || !song.spotify_track_id}
            title={favorited ? "Remove from Liked Songs" : "Save to Liked Songs"}
            className={`w-7 h-7 rounded-full flex items-center justify-center transition-all active:scale-90 disabled:opacity-30 ${
              favorited
                ? "text-rose-500 hover:text-rose-400"
                : "text-neutral-300 hover:text-rose-500"
            }`}
          >
            {favorited ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        </div>

        {/* Expand toggle */}
        {(song.top_mention || song.reasons.length > 1 || song.genres.length > 0) && (
          <button
            onClick={() => setExpanded(!expanded)}
            className={[
              "shrink-0 text-neutral-300 hover:text-neutral-500 transition-colors text-xs",
              compact ? "col-start-3 row-start-2 self-center justify-self-end" : "pt-3",
            ].join(" ")}
            title="More info"
          >
            {expanded ? "\u25be" : "\u25b8"}
          </button>
        )}
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className={["px-3 pb-3 space-y-2", compact ? "sm:pl-[4.75rem]" : "sm:pl-[6.5rem] sm:pr-6"].join(" ")}>
          <div className="bg-white border border-neutral-100 rounded-md px-3 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
              Why this song
            </p>
            <ul className="mt-1.5 space-y-1">
              {explanation.details.slice(0, 5).map((detail) => (
                <li key={detail} className="text-[11px] leading-relaxed text-neutral-600">
                  {detail}
                </li>
              ))}
            </ul>
          </div>

          {/* Signal breakdown */}
          <div className="flex gap-3 text-[10px] flex-wrap">
            <SignalPill label="Taste" value={song.signals.affinity} color="emerald" />
            <SignalPill label="Search" value={song.signals.context} color="blue" />
            <SignalPill label="Buzz" value={song.signals.editorial} color="amber" />
            {song.signals.track_popularity !== undefined && (
              <SignalPill label="Popularity" value={song.signals.track_popularity} color="purple" />
            )}
            {song.signals.novelty !== undefined && (
              <SignalPill label="Discovery" value={song.signals.novelty} color="emerald" />
            )}
          </div>

          {/* All reasons */}
          {song.reasons.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {song.reasons.map((r, i) => (
                <span
                  key={i}
                  className="text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-full px-2 py-0.5"
                >
                  {r}
                </span>
              ))}
              {song.mention_count > 0 && (
                <span className="text-[10px] text-neutral-500 bg-neutral-50 border border-neutral-100 rounded-full px-2 py-0.5">
                  {song.mention_count} mention{song.mention_count !== 1 ? "s" : ""}
                </span>
              )}
            </div>
          )}

          {/* Editorial excerpt */}
          {song.top_mention?.excerpt && (
            <div className="bg-neutral-50 border border-neutral-100 rounded-md px-3 py-2">
              <p className="text-[11px] text-neutral-600 leading-relaxed line-clamp-2 italic">
                &ldquo;{song.top_mention.excerpt}&rdquo;
              </p>
              {song.top_mention.source && (
                <div className="flex items-center gap-1.5 mt-1.5">
                  <SourceFavicon sourceUrl={song.top_mention.source_url} size={12} />
                  {song.top_mention.article_url ? (
                    <a
                      href={song.top_mention.article_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[10px] text-neutral-500 hover:text-neutral-700 hover:underline"
                    >
                      — {song.top_mention.source} ↗
                    </a>
                  ) : (
                    <p className="text-[10px] text-neutral-400">
                      — {song.top_mention.source}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Genre pills */}
          {song.genres.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {song.genres.slice(0, 5).map((g) => (
                <span
                  key={g}
                  className="text-[10px] text-neutral-500 bg-neutral-100 rounded-full px-2 py-0.5 capitalize"
                >
                  {g}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SignalPill({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  const pct = Math.round(value * 100);
  const colorMap: Record<string, string> = {
    emerald: "text-emerald-700 bg-emerald-50 border-emerald-100",
    blue: "text-blue-700 bg-blue-50 border-blue-100",
    amber: "text-amber-700 bg-amber-50 border-amber-100",
    purple: "text-purple-700 bg-purple-50 border-purple-100",
    rose: "text-rose-700 bg-rose-50 border-rose-100",
  };
  return (
    <span
      className={`border rounded-full px-2 py-0.5 tabular-nums ${
        colorMap[color] ?? colorMap.emerald
      }`}
    >
      {label} {pct}%
    </span>
  );
}

function WeightSlider({
  label,
  hint,
  value,
  dimmed,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  dimmed?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <label className={["block transition-opacity", dimmed ? "opacity-40" : ""].join(" ")}>
      <div className="flex items-center justify-between text-xs text-neutral-600 mb-1">
        <span className="font-medium" title={hint}>
          {label}
        </span>
        <span className="tabular-nums text-neutral-400">{value}%</span>
      </div>
      {hint && (
        <p className="text-[9px] text-neutral-400 mb-1.5 leading-tight">
          {hint}
        </p>
      )}
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={`${label} weight`}
        className="w-full accent-emerald-600"
      />
    </label>
  );
}

function getSourceDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function SourceFavicon({ sourceUrl, size = 14 }: { sourceUrl?: string; size?: number }) {
  const domain = sourceUrl ? getSourceDomain(sourceUrl) : "";
  if (!domain) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`https://www.google.com/s2/favicons?domain=${domain}&sz=${size * 2}`}
      alt=""
      width={size}
      height={size}
      className="rounded-sm shrink-0"
      style={{ imageRendering: "auto" }}
      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
    />
  );
}

function SourceBadge({ mention }: { mention: TopMention }) {
  const domain = mention.source_url ? getSourceDomain(mention.source_url) : "";
  const href = mention.article_url || (domain ? `https://${domain}` : undefined);

  const inner = (
    <span className="inline-flex items-center gap-1 text-[10px] text-neutral-400 mt-0.5">
      {domain && (
        <SourceFavicon sourceUrl={mention.source_url} size={11} />
      )}
      <span className="truncate max-w-[120px]">{mention.source}</span>
      {href && <span className="shrink-0">↗</span>}
    </span>
  );

  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="block hover:text-neutral-600 transition-colors"
        onClick={(e) => e.stopPropagation()}
        title={`Read on ${mention.source}`}
      >
        {inner}
      </a>
    );
  }
  return <div>{inner}</div>;
}

function SpotifyIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
    </svg>
  );
}

function SavePlaylistButton({
  state,
  count,
  onSave,
}: {
  state: "idle" | "saving" | "done" | "error";
  count: number;
  onSave: () => void;
}) {
  if (state === "done") {
    return (
      <button
        onClick={onSave}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-100 sm:w-auto"
        title="Create another playlist"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M12 5v14M5 12h14" strokeLinecap="round" />
        </svg>
        Save New Playlist
      </button>
    );
  }

  return (
    <button
      onClick={onSave}
      disabled={state === "saving" || count === 0}
      className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-[#1DB954] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#1aa34a] disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
      title={`Save ${count} songs as a Spotify playlist`}
    >
      {state === "saving" ? (
        <>
          <svg
            className="animate-spin"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          >
            <circle cx="12" cy="12" r="10" strokeOpacity="0.3" />
            <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
          </svg>
          Creating playlist…
        </>
      ) : (
        <>
          <SpotifyIcon size={14} />
          Save as Playlist
        </>
      )}
    </button>
  );
}

function EmptyInitial() {
  return (
    <div className="border border-dashed border-neutral-200 rounded-xl p-12 text-center space-y-3">
      <div className="text-4xl">\ud83c\udfa7</div>
      <div>
        <p className="text-sm font-medium text-neutral-700">
          Discover new songs
        </p>
        <p className="text-xs text-neutral-400 mt-1 max-w-xs mx-auto leading-relaxed">
          Describe what you&apos;re in the mood for, or just hit{" "}
          <strong>Discover</strong> to get personalized song recommendations
          based on your taste profile.
        </p>
      </div>
    </div>
  );
}

function EmptyNoResults() {
  const [missingStep, setMissingStep] = useState<
    "loading" | "sync" | "enrich" | "embed" | "tracks" | "modeledTracks" | "ready" | "unknown"
  >("loading");

  useEffect(() => {
    fetch("/api/readiness")
      .then((r) => r.json())
      .then((data) => {
        const steps = data.readiness?.steps;
        if (!steps?.imported) return setMissingStep("sync");
        if (!steps?.enriched) return setMissingStep("enrich");
        if (!steps?.embedded) return setMissingStep("embed");
        if (!steps?.tracks) return setMissingStep("tracks");
        if (!steps?.modeledTracks) return setMissingStep("modeledTracks");
        setMissingStep("ready");
      })
      .catch(() => setMissingStep("unknown"));
  }, []);

  const guidance = {
    loading: { title: "Checking your library\u2026", body: "" },
    sync: {
      title: "Sync your library first",
      body: "Click \u201cSync Library\u201d (step 1) in the left sidebar to import your Spotify artists.",
    },
    enrich: {
      title: "Enrich your artists next",
      body: "Click \u201cEnrich Artists\u201d (step 2) in the left sidebar to fetch genres and metadata.",
    },
    embed: {
      title: "Generate embeddings next",
      body: "Click \u201cGenerate Embeddings\u201d (step 3) in the left sidebar. This is what powers Discover.",
    },
    tracks: {
      title: "Track catalog is empty",
      body: "Your artists are ready but no playable tracks were loaded \u2014 this usually happens when Spotify rate limits block the initial setup. Re-run \u201cSet up music profile\u201d to try again.",
    },
    modeledTracks: {
      title: "Track embeddings missing",
      body: "Tracks exist but haven\u2019t been modeled yet. Re-run \u201cSet up music profile\u201d to generate track embeddings.",
    },
    ready: {
      title: "Nothing matched right now",
      body: "Your library is set up, but Discover came back empty this time. Try a different prompt or hit Discover again.",
    },
    unknown: {
      title: "No songs found",
      body: "Make sure you\u2019ve synced, enriched, and embedded your library first.",
    },
  }[missingStep];

  return (
    <div className="border border-dashed border-neutral-200 rounded-xl p-12 text-center space-y-3">
      <div className="text-4xl">\ud83c\udfbb</div>
      <div>
        <p className="text-sm font-medium text-neutral-700">{guidance.title}</p>
        {guidance.body && (
          <p className="text-xs text-neutral-400 mt-1 max-w-xs mx-auto leading-relaxed">
            {guidance.body}
          </p>
        )}
      </div>
    </div>
  );
}
