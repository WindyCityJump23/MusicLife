/**
 * Shared station/recommendation domain types.
 *
 * Extracted from discover-view.tsx so the pure helpers in this folder (and
 * their unit tests) can share one definition instead of re-declaring shapes.
 */

export type SignalBreakdown = {
  affinity: number;
  context: number;
  editorial: number;
  track_popularity?: number;
  novelty?: number;
  familiarity?: number;
  saved_anchor?: number;
  listen_boost?: number;
  audio_match?: number | null;
  live_source?: boolean;
};

export type TopMention = {
  source: string;
  source_url?: string;
  article_url?: string;
  excerpt: string;
  published_at: string;
};

export type DiscoveryLaneId = "radio_hits" | "popular" | "deep_cuts";

export type LaneFilterId = "all" | DiscoveryLaneId;

export type DiscoveryLane = {
  id: DiscoveryLaneId;
  title: string;
  subtitle: string;
};

export type SongRecommendation = {
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

export type Preset = {
  label: string;
  desc: string;
  weights: { affinity: number; context: number; editorial: number };
};

export type TasteStrategy = {
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
