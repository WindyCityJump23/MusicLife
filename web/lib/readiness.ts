/**
 * Canonical radio-readiness math and types.
 *
 * The required-artist / required-track formulas used to be duplicated (with
 * subtly different rounding) across the readiness route, radio-view, and the
 * Python backend. This module is the single source of truth on the web side;
 * `api/app/routes/ingest.py` mirrors the same formula and the two are kept in
 * sync by the values returned from `/api/readiness` (the server is
 * authoritative — these helpers are the fallback when a field is absent).
 */

export type ReadinessSteps = {
  imported?: boolean;
  enriched?: boolean;
  embedded?: boolean;
  context?: boolean;
  tracks?: boolean;
  modeledTracks?: boolean;
};

export type ReadinessStats = {
  artistCount?: number;
  trackCount?: number;
  catalogTrackCount?: number;
  playableTrackCount?: number;
  modeledTrackCount?: number;
  recentPlayCount?: number;
  mentionCount?: number;
};

export type CatalogStats = {
  library: number;
  discovered: number;
  embedded: number;
};

export type ReadinessPayload = {
  stats?: ReadinessStats;
  catalogStats?: CatalogStats;
  readiness?: {
    radioReady?: boolean;
    requiredArtistCount?: number;
    requiredPlayableTrackCount?: number;
    requiredModeledTrackCount?: number;
    enrichedCount?: number;
    embeddedCount?: number;
    playableTrackCount?: number;
    modeledTrackCount?: number;
    steps?: ReadinessSteps;
  };
};

/** Number of taste-modeled artists required before radio is considered ready. */
export function requiredArtistCount(artistCount: number): number {
  if (artistCount <= 0) return 0;
  return Math.min(artistCount, Math.max(5, Math.ceil(artistCount * 0.25)));
}

/** Number of playable Spotify tracks required before radio is considered ready. */
export function requiredPlayableTrackCount(
  artistCount: number,
  requiredArtists: number = requiredArtistCount(artistCount)
): number {
  if (artistCount <= 0) return 0;
  return Math.min(50, Math.max(10, requiredArtists * 3));
}

/** Set of completed step numbers (1–6) derived from the readiness steps map. */
export function completedStepNumbers(steps: ReadinessSteps | undefined): Set<number> {
  const done = new Set<number>();
  if (!steps) return done;
  if (steps.imported) done.add(1);
  if (steps.enriched) done.add(2);
  if (steps.embedded) done.add(3);
  if (steps.context) done.add(4);
  if (steps.tracks) done.add(5);
  if (steps.modeledTracks) done.add(6);
  return done;
}

export type RadioReadiness = {
  loading: boolean;
  ready: boolean;
  artistCount: number;
  enrichedCount: number;
  embeddedCount: number;
  playableTrackCount: number;
  requiredArtistCount: number;
  requiredPlayableTrackCount: number;
};

export const EMPTY_RADIO_READINESS: RadioReadiness = {
  loading: true,
  ready: false,
  artistCount: 0,
  enrichedCount: 0,
  embeddedCount: 0,
  playableTrackCount: 0,
  requiredArtistCount: 0,
  requiredPlayableTrackCount: 0,
};

/** Reduce a `/api/readiness` payload into the flat shape radio-view consumes. */
export function toRadioReadiness(payload: ReadinessPayload): RadioReadiness {
  const serverReadiness = payload.readiness ?? {};
  const artistCount = payload.stats?.artistCount ?? 0;
  const reqArtists =
    serverReadiness.requiredArtistCount ?? requiredArtistCount(artistCount);
  const playableTrackCount =
    serverReadiness.playableTrackCount ?? payload.stats?.playableTrackCount ?? 0;
  const reqTracks =
    serverReadiness.requiredPlayableTrackCount ??
    requiredPlayableTrackCount(artistCount, reqArtists);
  const ready =
    typeof serverReadiness.radioReady === "boolean"
      ? serverReadiness.radioReady
      : artistCount > 0 &&
        (serverReadiness.enrichedCount ?? 0) >= reqArtists &&
        (serverReadiness.embeddedCount ?? 0) >= reqArtists &&
        playableTrackCount >= reqTracks;

  return {
    loading: false,
    ready,
    artistCount,
    enrichedCount: serverReadiness.enrichedCount ?? 0,
    embeddedCount: serverReadiness.embeddedCount ?? 0,
    playableTrackCount,
    requiredArtistCount: reqArtists,
    requiredPlayableTrackCount: reqTracks,
  };
}
