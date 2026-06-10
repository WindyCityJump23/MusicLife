import type { SongRecommendation, SignalBreakdown } from "./types";

/** Build a SongRecommendation for tests with sensible defaults. */
export function makeSong(overrides: Partial<SongRecommendation> = {}): SongRecommendation {
  const signals: SignalBreakdown = {
    affinity: 0.5,
    context: 0,
    editorial: 0,
    ...(overrides.signals ?? {}),
  };
  return {
    track_id: null,
    track_name: "Test Track",
    artist_id: "1",
    artist_name: "Test Artist",
    album_name: "Test Album",
    release_date: null,
    duration_ms: 180_000,
    explicit: false,
    spotify_track_id: "sp_test",
    score: 0.5,
    novelty_score: 0,
    familiarity_score: 0,
    reasons: [],
    genres: [],
    mention_count: 0,
    top_mention: null,
    ...overrides,
    signals,
  };
}
