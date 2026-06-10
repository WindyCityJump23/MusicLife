/**
 * Lane assignment, grouping, and playback interleaving.
 *
 * Pure functions extracted from discover-view.tsx. These encode how the queue
 * is split across radio-hits / popular / deep-cuts lanes and how those lanes
 * are interleaved for in-order playback — prime regression-test territory.
 */

import type { DiscoveryLaneId, SongRecommendation } from "./types";

export function emptyDiscoveryGroups(): Record<DiscoveryLaneId, SongRecommendation[]> {
  return {
    radio_hits: [],
    popular: [],
    deep_cuts: [],
  };
}

/** Resolve a song's display lane, preferring the backend-assigned lane. */
export function laneForSong(song: SongRecommendation): DiscoveryLaneId {
  if (song.lane) {
    if (song.lane === "deep_cuts" || song.lane === "deep_cut") return "deep_cuts";
    if (song.lane === "radio_hits" || song.lane === "radio_hit" || song.lane === "familiar")
      return "radio_hits";
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

export function laneBadge(
  song: SongRecommendation
): { label: string; className: string } | null {
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

/** Target counts for the recognizable (radio-hit) and deep-cut lanes. */
export function targetLaneCounts(total: number): { radio_hits: number; deep_cuts: number } {
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

/** Split a flat song list into the three discovery lanes, preserving order. */
export function groupSongsByLane(
  songs: SongRecommendation[]
): Record<DiscoveryLaneId, SongRecommendation[]> {
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
    .slice(
      0,
      Math.max(0, targets.radio_hits - assigned.filter(({ lane }) => lane === "radio_hits").length)
    )
    .forEach((item) => {
      item.lane = "radio_hits";
    });

  [...byRecognition]
    .reverse()
    .filter(({ lane }) => lane === null)
    .slice(
      0,
      Math.max(0, targets.deep_cuts - assigned.filter(({ lane }) => lane === "deep_cuts").length)
    )
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

/** Round-robin the lanes so playback alternates deep cuts, popular, hits. */
export function interleaveForPlayback(songs: SongRecommendation[]): SongRecommendation[] {
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
