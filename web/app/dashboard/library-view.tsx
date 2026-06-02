"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePlayer } from "./player-context";
import { useAuth } from "./auth-context";
import SetupAllButton from "./SetupAllButton";

type Artist = {
  id: number;
  name: string;
  genres: string[];
  enriched: boolean;
  embedded: boolean;
  image_url: string | null;
};

type Readiness = {
  radioReady: boolean;
  requiredArtistCount: number;
  requiredPlayableTrackCount: number;
  requiredModeledTrackCount: number;
  enrichedCount: number;
  embeddedCount: number;
  playableTrackCount: number;
  modeledTrackCount: number;
  steps: {
    imported: boolean;
    enriched: boolean;
    embedded: boolean;
    context: boolean;
    tracks: boolean;
    modeledTracks: boolean;
  };
};

type LibraryData = {
  stats: {
    artistCount: number;
    trackCount: number;
    catalogTrackCount: number;
    playableTrackCount: number;
    modeledTrackCount: number;
    recentPlayCount: number;
    mentionCount: number;
  };
  readiness: Readiness;
  tasteSnapshot: TasteSnapshot | null;
  artists: Artist[];
};

type TasteSnapshot = {
  generated_at: string;
  top_genres: Array<{ genre: string; count: number }>;
  anchor_artists: Array<{ id: number | null; name: string; count: number }>;
  feedback_summary: {
    reason?: string;
    events?: Record<string, number>;
  };
  thesis: string;
};

type DiscoveryMix = {
  deep_cuts: number;
  popular: number;
  radio_hits: number;
};

type TasteStrategy = {
  genre_boosts: string[];
  genre_avoids: string[];
  discovery_mix: DiscoveryMix;
  station_distance: "closer" | "balanced" | "further";
  familiarity: "anchors" | "balanced" | "surprises";
  live_expansion: "auto" | "catalog" | "live";
  freshness: "newer" | "balanced" | "timeless";
};

type SortKey = "az" | "za";
type LaneKey = keyof DiscoveryMix;

const DEFAULT_STRATEGY: TasteStrategy = {
  genre_boosts: [],
  genre_avoids: [],
  discovery_mix: { deep_cuts: 38, popular: 38, radio_hits: 24 },
  station_distance: "balanced",
  familiarity: "balanced",
  live_expansion: "auto",
  freshness: "balanced",
};

const DISTANCE_OPTIONS: Array<{ id: TasteStrategy["station_distance"]; label: string; body: string; mix: DiscoveryMix }> = [
  { id: "closer", label: "Closer", body: "Keep Radio near your strongest anchors.", mix: { deep_cuts: 22, popular: 44, radio_hits: 34 } },
  { id: "balanced", label: "Balanced", body: "Move between anchors and discovery without losing the thread.", mix: DEFAULT_STRATEGY.discovery_mix },
  { id: "further", label: "Further out", body: "Give Radio more room for new edges and deep cuts.", mix: { deep_cuts: 55, popular: 32, radio_hits: 13 } },
];

const FAMILIARITY_OPTIONS: Array<{ id: TasteStrategy["familiarity"]; label: string; body: string; mixPatch: Partial<DiscoveryMix> }> = [
  { id: "anchors", label: "More anchors", body: "Favor recognizable artists and grounded picks.", mixPatch: { radio_hits: 34, deep_cuts: 24 } },
  { id: "balanced", label: "Balanced", body: "Keep familiar and surprising songs in tension.", mixPatch: {} },
  { id: "surprises", label: "More surprises", body: "Reduce obvious picks and let novelty breathe.", mixPatch: { radio_hits: 14, deep_cuts: 50 } },
];

const LANE_META: Array<{ id: LaneKey; label: string; help: string; feeling: string }> = [
  {
    id: "deep_cuts",
    label: "Take me further out",
    help: "Lower-popularity finds and new-to-you artists",
    feeling: "Exploratory",
  },
  {
    id: "popular",
    label: "Keep one foot familiar",
    help: "Known, but less obvious songs",
    feeling: "Connected",
  },
  {
    id: "radio_hits",
    label: "Stay close to my core",
    help: "Recognizable anchors that keep stations grounded",
    feeling: "Grounded",
  },
];

const LIVE_OPTIONS: Array<{ id: TasteStrategy["live_expansion"]; label: string; body: string }> = [
  { id: "auto", label: "Balanced reach", body: "Use MusicLife's best matches while leaving room for fresh Spotify finds." },
  { id: "catalog", label: "Close to core", body: "Stay nearest to your strongest matches, with a small lane for new finds." },
  { id: "live", label: "Wide open", body: "Keep a larger window open for new Spotify discoveries." },
];

const FRESHNESS_OPTIONS: Array<{ id: TasteStrategy["freshness"]; label: string; body: string }> = [
  { id: "newer", label: "Make it feel current", body: "Tilt toward recent releases and fresh context." },
  { id: "balanced", label: "Now and lasting", body: "Blend new songs with durable favorites." },
  { id: "timeless", label: "Timeless pull", body: "Let older high-confidence songs compete." },
];

const POINT_OF_VIEW_PRESETS: Array<{
  title: string;
  body: string;
  mix: DiscoveryMix;
  live_expansion: TasteStrategy["live_expansion"];
  freshness: TasteStrategy["freshness"];
}> = [
  {
    title: "Take me further out",
    body: "Open the edges of the station and let newer discoveries breathe.",
    mix: { deep_cuts: 55, popular: 30, radio_hits: 15 },
    live_expansion: "live",
    freshness: "newer",
  },
  {
    title: "Keep one foot familiar",
    body: "Let discovery move, but keep enough known gravity that the station feels like yours.",
    mix: { deep_cuts: 30, popular: 45, radio_hits: 25 },
    live_expansion: "auto",
    freshness: "balanced",
  },
  {
    title: "Make it feel current",
    body: "Prioritize recent context and leave a steady lane for fresh Spotify finds.",
    mix: { deep_cuts: 38, popular: 42, radio_hits: 20 },
    live_expansion: "live",
    freshness: "newer",
  },
  {
    title: "Stay close to my core",
    body: "Use your strongest taste signals as the center of gravity and add only careful surprises.",
    mix: { deep_cuts: 22, popular: 46, radio_hits: 32 },
    live_expansion: "catalog",
    freshness: "timeless",
  },
];

function normalizeGenre(value: string): string {
  const normalized = value.trim().toLowerCase().slice(0, 48);
  if (
    normalized.includes("_") ||
    normalized.includes("lidarr") ||
    normalized.includes("batch")
  ) {
    return "";
  }
  return normalized;
}

function normalizeMix(mix: DiscoveryMix): DiscoveryMix {
  const deep = Math.max(0, Number(mix.deep_cuts) || 0);
  const popular = Math.max(0, Number(mix.popular) || 0);
  const hits = Math.max(0, Number(mix.radio_hits) || 0);
  const total = deep + popular + hits;
  if (total <= 0) return DEFAULT_STRATEGY.discovery_mix;
  const deepPct = Math.round((deep / total) * 100);
  const popularPct = Math.round((popular / total) * 100);
  return {
    deep_cuts: deepPct,
    popular: popularPct,
    radio_hits: Math.max(0, 100 - deepPct - popularPct),
  };
}

function updateMix(mix: DiscoveryMix, lane: LaneKey, value: number): DiscoveryMix {
  const nextValue = Math.max(0, Math.min(100, Math.round(value)));
  const otherLanes = LANE_META.map((item) => item.id).filter((id) => id !== lane);
  const remaining = 100 - nextValue;
  const otherTotal = otherLanes.reduce((sum, id) => sum + mix[id], 0);
  const next = { ...mix, [lane]: nextValue };
  otherLanes.forEach((id, index) => {
    if (otherTotal <= 0) {
      next[id] = index === 0 ? Math.round(remaining / 2) : remaining - Math.round(remaining / 2);
    } else {
      next[id] = Math.round((mix[id] / otherTotal) * remaining);
    }
  });
  return normalizeMix(next);
}

function mixForDistanceAndFamiliarity(
  distance: TasteStrategy["station_distance"],
  familiarity: TasteStrategy["familiarity"]
): DiscoveryMix {
  const base = DISTANCE_OPTIONS.find((option) => option.id === distance)?.mix ?? DEFAULT_STRATEGY.discovery_mix;
  const patch = FAMILIARITY_OPTIONS.find((option) => option.id === familiarity)?.mixPatch ?? {};
  return normalizeMix({ ...base, ...patch });
}

function sameStrategy(a: TasteStrategy, b: TasteStrategy): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function strongestLane(mix: DiscoveryMix): LaneKey {
  return (Object.keys(mix) as LaneKey[]).sort((a, b) => mix[b] - mix[a])[0] ?? "popular";
}

function buildTasteThesis(
  data: LibraryData,
  topGenres: Array<{ genre: string; count: number }>,
  strategy: TasteStrategy
): { headline: string; body: string; cues: string[] } {
  const coreGenres = topGenres.slice(0, 3).map((item) => item.genre);
  const core = coreGenres.length > 0 ? coreGenres.join(", ") : "your saved artists";
  const lane = strongestLane(strategy.discovery_mix);
  const laneText =
    lane === "deep_cuts"
      ? "curious and edge-seeking"
      : lane === "radio_hits"
        ? "anchored and high-recognition"
        : "balanced between known songs and discovery";
  const freshnessText =
    strategy.freshness === "newer"
      ? "with a clear bias toward what feels current"
      : strategy.freshness === "timeless"
        ? "with room for older high-confidence records"
        : "without losing the thread between new and lasting";
  const liveText =
    strategy.live_expansion === "live"
      ? "MusicLife will give the next station a wider discovery lane."
      : strategy.live_expansion === "catalog"
        ? "MusicLife will keep the next station close to your strongest matches while still checking for careful surprises."
        : "MusicLife will start from its strongest matches and add fresh finds when they improve the run.";
  const readiness = data.readiness.radioReady
    ? "Radio has enough signal to make song-level calls."
    : "Radio is still learning, so setup progress will improve the thesis.";

  return {
    headline: `Your taste reads as ${laneText}.`,
    body: `The strongest signals are ${core}, ${freshnessText}. ${liveText}`,
    cues: [
      `${data.stats.artistCount.toLocaleString()} artists in the taste graph`,
      `${data.stats.modeledTrackCount.toLocaleString()} songs ready for matching`,
      readiness,
    ],
  };
}

function pointOfViewSentence(strategy: TasteStrategy): string {
  const lane = strongestLane(strategy.discovery_mix);
  const lanePhrase =
    lane === "deep_cuts"
      ? "take you further out"
      : lane === "radio_hits"
        ? "stay close to your core"
        : "keep one foot familiar";
  const freshnessPhrase =
    strategy.freshness === "newer"
      ? "make it feel current"
      : strategy.freshness === "timeless"
        ? "trust timeless fit"
        : "balance fresh records with durable favorites";
  const livePhrase =
    strategy.live_expansion === "live"
      ? "with a wider discovery lane"
      : strategy.live_expansion === "catalog"
        ? "close to your strongest matches"
        : "with fresh Spotify finds held in reserve";
  return `Next Radio should ${lanePhrase}, ${freshnessPhrase}, ${livePhrase}.`;
}

function tasteSnapshotSummary(
  data: LibraryData,
  topGenres: Array<{ genre: string; count: number }>,
  influenceArtists: Artist[],
  strategy: TasteStrategy,
  isGuest: boolean
): Array<{ label: string; body: string }> {
  const snapshot = data.tasteSnapshot;
  const genres = (snapshot?.top_genres ?? topGenres)
    .map((item) => normalizeGenre(item.genre))
    .filter(Boolean)
    .slice(0, 3);
  const anchors = (snapshot?.anchor_artists ?? influenceArtists)
    .slice(0, 3)
    .map((item) => item.name)
    .filter(Boolean);
  const reason = snapshot?.feedback_summary?.reason ?? "";
  const eventLabels: Record<string, string> = {
    play: "plays",
    skip: "skips",
    thumb_up: "likes",
    thumb_down: "dislikes",
    too_familiar: "too-familiar notes",
    too_far: "too-far-out notes",
    favorite: "favorites",
    save_playlist: "playlist saves",
    open_spotify: "Spotify opens",
  };
  const recentSignals = Object.entries(snapshot?.feedback_summary?.events ?? {})
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([event, count]) => `${count} ${eventLabels[event] ?? "Radio signals"}`);
  const learnedFrom =
    recentSignals.length > 0
      ? recentSignals.join(", ")
      : reason === "playlist_import"
        ? "your latest playlist import"
        : reason.startsWith("setup_all:")
          ? "your latest Spotify sync"
          : isGuest
            ? "your imported playlist"
            : "your Spotify history";
  const reach =
    strategy.station_distance === "closer"
      ? "Closer to your anchors, with careful surprises."
      : strategy.station_distance === "further"
        ? "Further into new artists and deep cuts."
        : "Between trusted anchors and fresh discoveries.";

  return [
    {
      label: "You lean toward",
      body: genres.length > 0 ? genres.join(", ") : "the artists already shaping your library",
    },
    {
      label: "Radio will reach",
      body: reach,
    },
    {
      label: "Your strongest anchors are",
      body: anchors.length > 0 ? anchors.join(", ") : "still taking shape",
    },
    {
      label: "Recently learned from",
      body: learnedFrom,
    },
  ];
}

export default function LibraryView({
  onSetupComplete,
}: {
  onSetupComplete?: () => void;
}) {
  const { isGuest } = useAuth();
  const [data, setData] = useState<LibraryData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("az");
  const [strategy, setStrategy] = useState<TasteStrategy>(DEFAULT_STRATEGY);
  const [savedStrategy, setSavedStrategy] = useState<TasteStrategy>(DEFAULT_STRATEGY);
  const [genreInput, setGenreInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [reimportUrl, setReimportUrl] = useState("");
  const [reimportLoading, setReimportLoading] = useState(false);
  const [reimportMessage, setReimportMessage] = useState<string | null>(null);
  const [reimportError, setReimportError] = useState<string | null>(null);

  const fetchLibrary = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      fetch("/api/library").then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Failed to load library");
        return body as LibraryData;
      }),
      fetch("/api/taste-strategy", { cache: "no-store" })
        .then((res) => res.json())
        .catch(() => ({ strategy: DEFAULT_STRATEGY })),
    ])
      .then(([libraryBody, strategyBody]) => {
        const nextStrategy = {
          ...DEFAULT_STRATEGY,
          ...(strategyBody.strategy ?? {}),
          discovery_mix: normalizeMix(strategyBody.strategy?.discovery_mix ?? DEFAULT_STRATEGY.discovery_mix),
        };
        setData(libraryBody);
        setStrategy(nextStrategy);
        setSavedStrategy(nextStrategy);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Network error");
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    fetchLibrary();
  }, [fetchLibrary]);

  const topGenres = useMemo(() => {
    const counts = new Map<string, number>();
    for (const artist of data?.artists ?? []) {
      for (const genre of artist.genres ?? []) {
        const key = normalizeGenre(genre);
        if (!key) continue;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 14)
      .map(([genre, count]) => ({ genre, count }));
  }, [data]);

  const filtered = useMemo(() => {
    return (data?.artists ?? [])
      .filter((a) => a.name.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) =>
        sort === "az"
          ? a.name.localeCompare(b.name)
          : b.name.localeCompare(a.name)
      );
  }, [data, search, sort]);

  const influenceArtists = useMemo(() => {
    return [...(data?.artists ?? [])]
      .sort((a, b) => Number(b.embedded) - Number(a.embedded) || b.genres.length - a.genres.length || a.name.localeCompare(b.name))
      .slice(0, 12);
  }, [data]);

  const tasteThesis = useMemo(() => {
    return data ? buildTasteThesis(data, topGenres, strategy) : null;
  }, [data, topGenres, strategy]);

  const thesisSummary = useMemo(() => {
    return data ? tasteSnapshotSummary(data, topGenres, influenceArtists, strategy, isGuest) : [];
  }, [data, topGenres, influenceArtists, strategy, isGuest]);

  const dirty = !sameStrategy(strategy, savedStrategy);

  function addGenre(kind: "boost" | "avoid", rawGenre: string) {
    const genre = normalizeGenre(rawGenre);
    if (!genre) return;
    setStrategy((current) => {
      const boostSet = new Set(current.genre_boosts);
      const avoidSet = new Set(current.genre_avoids);
      if (kind === "boost") {
        boostSet.add(genre);
        avoidSet.delete(genre);
      } else {
        avoidSet.add(genre);
        boostSet.delete(genre);
      }
      return {
        ...current,
        genre_boosts: [...boostSet].slice(0, 12),
        genre_avoids: [...avoidSet].slice(0, 12),
      };
    });
    setGenreInput("");
    setSaveMessage(null);
  }

  function removeGenre(kind: "boost" | "avoid", genre: string) {
    setStrategy((current) => ({
      ...current,
      genre_boosts: kind === "boost" ? current.genre_boosts.filter((g) => g !== genre) : current.genre_boosts,
      genre_avoids: kind === "avoid" ? current.genre_avoids.filter((g) => g !== genre) : current.genre_avoids,
    }));
    setSaveMessage(null);
  }

  function applyPointOfViewPreset(preset: (typeof POINT_OF_VIEW_PRESETS)[number]) {
    setStrategy((current) => ({
      ...current,
      discovery_mix: normalizeMix(preset.mix),
      station_distance: preset.title === "Take me further out" ? "further" : preset.title === "Stay close to my core" ? "closer" : "balanced",
      familiarity: preset.title === "Stay close to my core" ? "anchors" : preset.title === "Take me further out" ? "surprises" : "balanced",
      live_expansion: preset.live_expansion,
      freshness: preset.freshness,
    }));
    setSaveMessage(null);
  }

  function setStationDistance(value: TasteStrategy["station_distance"]) {
    setStrategy((current) => ({
      ...current,
      station_distance: value,
      discovery_mix: mixForDistanceAndFamiliarity(value, current.familiarity),
    }));
    setSaveMessage(null);
  }

  function setFamiliarity(value: TasteStrategy["familiarity"]) {
    setStrategy((current) => ({
      ...current,
      familiarity: value,
      discovery_mix: mixForDistanceAndFamiliarity(current.station_distance, value),
    }));
    setSaveMessage(null);
  }

  async function saveStrategy() {
    setSaving(true);
    setSaveMessage(null);
    try {
      const res = await fetch("/api/taste-strategy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(strategy),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Failed to save taste strategy");
      const nextStrategy = {
        ...DEFAULT_STRATEGY,
        ...(body.strategy ?? strategy),
        discovery_mix: normalizeMix(body.strategy?.discovery_mix ?? strategy.discovery_mix),
      };
      setStrategy(nextStrategy);
      setSavedStrategy(nextStrategy);
      setSaveMessage("Saved. Radio will use this strategy on unprompted runs.");
    } catch (err) {
      setSaveMessage(err instanceof Error ? err.message : "Could not save strategy.");
    } finally {
      setSaving(false);
    }
  }

  async function handleReimport(e: React.FormEvent) {
    e.preventDefault();
    if (!reimportUrl.trim() || reimportLoading) return;
    setReimportLoading(true);
    setReimportError(null);
    setReimportMessage(null);
    try {
      const res = await fetch("/api/import-playlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: reimportUrl.trim() }),
      });
      const body = await res.json();
      if (!res.ok) {
        setReimportError(body.message ?? body.error ?? "Import failed");
        return;
      }
      setReimportMessage(
        `Added ${body.track_count} tracks from ${body.artist_count} artists. Refreshing...`
      );
      setReimportUrl("");
      // Give a moment for the success message to display, then refresh
      setTimeout(() => {
        fetchLibrary();
        setReimportMessage(null);
      }, 1500);
    } catch {
      setReimportError("Network error. Please check your connection.");
    } finally {
      setReimportLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-24 rounded-lg border border-neutral-200 bg-white skeleton-shimmer" />
        <div className="grid gap-3 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-28 rounded-lg border border-neutral-200 bg-white skeleton-shimmer" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        <span>{error}</span>
        <button
          onClick={fetchLibrary}
          className="shrink-0 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-100"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!data || data.artists.length === 0) {
    return (
      <div className="mx-auto max-w-sm space-y-6 py-8">
        <div className="space-y-2 text-center">
          <h2 className="text-lg font-semibold text-neutral-900">Welcome to MusicLife</h2>
          <p className="text-sm leading-relaxed text-neutral-500">
            {isGuest
              ? "Import a playlist to build the taste profile that powers recommendations."
              : "Connect your Spotify library to build the taste profile that powers Radio."}
          </p>
        </div>
        <SetupAllButton onProgress={fetchLibrary} onComplete={onSetupComplete} />
        <div className="space-y-2.5 pt-1">
          {[
            { n: 1, title: "Sync library", desc: "Import artists and listening history" },
            { n: 2, title: "Learn your artists", desc: "Add genres and artist context" },
            { n: 3, title: "Connect your taste", desc: "Prepare stronger station matches" },
            { n: 4, title: "Add music context", desc: "Include editorial context and reviews" },
            { n: 5, title: "Prepare playable songs", desc: "Load songs for Radio" },
            { n: 6, title: "Refine discovery", desc: "Improve song-level matching over time" },
          ].map(({ n, title, desc }) => (
            <div key={n} className="flex items-start gap-2.5">
              <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-[10px] font-bold text-neutral-500">
                {n}
              </div>
              <div>
                <p className="text-xs font-medium leading-tight text-neutral-800">{title}</p>
                <p className="mt-0.5 text-[10px] leading-snug text-neutral-400">{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl space-y-4">
      <section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm shadow-neutral-100/70">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-emerald-600">
              Taste Profile
            </p>
            <h3 className="mt-1 text-xl font-semibold tracking-tight text-neutral-950">
              Here is what MusicLife thinks your taste is.
            </h3>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-neutral-500">
              {isGuest
                ? "Your imported playlist shapes your taste profile. Adjust your station point of view to tell Radio how far to reach and which genres should carry more gravity."
                : "Your Spotify history shapes your taste profile. Your station point of view tells Radio how far to reach, how current to feel, and which genres should carry more gravity."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {saveMessage && (
              <span className="text-xs text-neutral-500">{saveMessage}</span>
            )}
            <button
              onClick={() => {
                setStrategy(savedStrategy);
                setSaveMessage(null);
              }}
              disabled={!dirty || saving}
              className="min-h-[38px] rounded-lg border border-neutral-200 bg-white px-3 py-2 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Reset
            </button>
            <button
              onClick={saveStrategy}
              disabled={!dirty || saving}
              className="min-h-[38px] rounded-lg bg-neutral-900 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving ? "Saving" : "Save strategy"}
            </button>
          </div>
        </div>

        <details className="mt-4 rounded-lg border border-neutral-200 bg-neutral-50/60 p-3">
          <summary className="cursor-pointer text-xs font-medium text-neutral-700">
            Model details
          </summary>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <SnapshotMetric label="Artists" value={data.stats.artistCount} />
            <SnapshotMetric label="Saved tracks" value={data.stats.trackCount} />
            <SnapshotMetric label="Recent plays" value={data.stats.recentPlayCount} />
            <SnapshotMetric label="Modeled songs" value={data.stats.modeledTrackCount} />
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <ReadinessPill label="Taste model" done={data.readiness.steps.embedded} detail={`${data.readiness.embeddedCount}/${data.readiness.requiredArtistCount} artists`} />
            <ReadinessPill label="Song catalog" done={data.readiness.steps.tracks} detail={`${data.readiness.playableTrackCount}/${data.readiness.requiredPlayableTrackCount} playable`} />
            <ReadinessPill label="Music context" done={data.readiness.steps.context} detail={`${data.stats.mentionCount.toLocaleString()} mentions`} />
          </div>
        </details>

        {/* Re-import playlist for guests */}
        {isGuest && (
          <div className="mt-4 rounded-lg border border-neutral-200 bg-neutral-50/70 p-4">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-neutral-500">
              Update your taste
            </p>
            <p className="mt-1 text-sm text-neutral-600 leading-relaxed">
              Import another playlist to add more artists and tracks to your taste profile.
            </p>
            <form onSubmit={handleReimport} className="mt-3 flex gap-2">
              <input
                type="text"
                value={reimportUrl}
                onChange={(e) => {
                  setReimportUrl(e.target.value);
                  if (reimportError) setReimportError(null);
                }}
                placeholder="Paste a Spotify playlist link..."
                disabled={reimportLoading}
                className="flex-1 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm placeholder:text-neutral-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={!reimportUrl.trim() || reimportLoading}
                className="shrink-0 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
              >
                {reimportLoading ? "Importing..." : "Re-import"}
              </button>
            </form>
            {reimportError && (
              <p className="mt-2 text-xs text-red-600">{reimportError}</p>
            )}
            {reimportMessage && (
              <p className="mt-2 text-xs text-emerald-700">{reimportMessage}</p>
            )}
          </div>
        )}

        {tasteThesis && (
          <div className="mt-4 rounded-lg border border-emerald-100 bg-emerald-50/70 p-4">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-emerald-700">
              Taste thesis
            </p>
            <h3 className="mt-1 text-base font-semibold text-neutral-950">{tasteThesis.headline}</h3>
            <p className="mt-1 max-w-3xl text-sm leading-relaxed text-neutral-600">
              {tasteThesis.body}
            </p>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {thesisSummary.map((item) => (
                <div key={item.label} className="rounded-md border border-emerald-100 bg-white/80 px-3 py-2.5">
                  <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-emerald-700">
                    {item.label}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-neutral-700">{item.body}</p>
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {tasteThesis.cues.map((cue) => (
                <span key={cue} className="rounded-full border border-emerald-100 bg-white/80 px-2.5 py-1 text-[11px] text-emerald-800">
                  {cue}
                </span>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
        <div className="space-y-4 rounded-lg border border-neutral-200 bg-white p-4 shadow-sm shadow-neutral-100/70">
          <div>
            <h3 className="text-base font-semibold text-neutral-950">Station point of view</h3>
            <p className="mt-1 text-xs leading-relaxed text-neutral-500">
              Choose the sentence your next station should finish. Saved choices apply to Taste radio; typed prompts still steer that single run directly.
            </p>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {POINT_OF_VIEW_PRESETS.map((preset) => (
              <button
                key={preset.title}
                onClick={() => applyPointOfViewPreset(preset)}
                className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-3 text-left transition-colors hover:border-emerald-200 hover:bg-emerald-50"
              >
                <span className="block text-sm font-semibold text-neutral-900">{preset.title}</span>
                <span className="mt-1 block text-xs leading-relaxed text-neutral-500">{preset.body}</span>
              </button>
            ))}
          </div>

          <div className="grid gap-3 border-t border-neutral-100 pt-4 md:grid-cols-2">
            <OptionGroup
              title="Station distance"
              options={DISTANCE_OPTIONS}
              value={strategy.station_distance}
              onChange={(value) => setStationDistance(value as TasteStrategy["station_distance"])}
            />
            <OptionGroup
              title="Familiarity"
              options={FAMILIARITY_OPTIONS}
              value={strategy.familiarity}
              onChange={(value) => setFamiliarity(value as TasteStrategy["familiarity"])}
            />
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-neutral-900">Genre boosts</p>
                <p className="text-xs text-neutral-500">Give these styles extra gravity.</p>
              </div>
              <div className="flex min-w-[220px] gap-2">
                <input
                  value={genreInput}
                  onChange={(e) => setGenreInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addGenre("boost", genreInput);
                  }}
                  placeholder="Add a genre"
                  className="min-h-[36px] w-full rounded-lg border border-neutral-200 px-3 py-2 text-xs focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
                <button
                  onClick={() => addGenre("boost", genreInput)}
                  className="min-h-[36px] rounded-lg border border-neutral-200 px-3 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
                >
                  Add
                </button>
              </div>
            </div>
            <GenreChipRow
              genres={strategy.genre_boosts}
              empty="No boosted genres yet"
              tone="boost"
              onRemove={(genre) => removeGenre("boost", genre)}
            />
            <GenreChipRow
              genres={topGenres.map((item) => item.genre).filter((genre) => !strategy.genre_boosts.includes(genre)).slice(0, 8)}
              empty=""
              tone="suggestion"
              onAdd={(genre) => addGenre("boost", genre)}
            />
          </div>

          <div className="space-y-3 border-t border-neutral-100 pt-4">
            <div>
              <p className="text-sm font-medium text-neutral-900">Genres to soften</p>
              <p className="text-xs text-neutral-500">Apply a penalty without blocking good matches completely.</p>
            </div>
            <GenreChipRow
              genres={strategy.genre_avoids}
              empty="No softened genres"
              tone="avoid"
              onRemove={(genre) => removeGenre("avoid", genre)}
            />
          </div>

          <div className="space-y-3 border-t border-neutral-100 pt-4">
            <div>
              <p className="text-sm font-medium text-neutral-900">How far should Radio reach?</p>
              <p className="text-xs text-neutral-500">The percentages stay precise, but the intent is musical: distance, familiarity, and grounding.</p>
            </div>
            {LANE_META.map((lane) => (
              <MixSlider
                key={lane.id}
                label={lane.label}
                help={lane.help}
                feeling={lane.feeling}
                value={strategy.discovery_mix[lane.id]}
                onChange={(value) =>
                  setStrategy((current) => ({
                    ...current,
                    discovery_mix: updateMix(current.discovery_mix, lane.id, value),
                  }))
                }
              />
            ))}
          </div>

          <div className="grid gap-3 border-t border-neutral-100 pt-4 md:grid-cols-2">
            <OptionGroup
              title="Discovery reach"
              options={LIVE_OPTIONS}
              value={strategy.live_expansion}
              onChange={(value) => setStrategy((current) => ({ ...current, live_expansion: value as TasteStrategy["live_expansion"] }))}
            />
            <OptionGroup
              title="Freshness"
              options={FRESHNESS_OPTIONS}
              value={strategy.freshness}
              onChange={(value) => setStrategy((current) => ({ ...current, freshness: value as TasteStrategy["freshness"] }))}
            />
          </div>
        </div>

        <aside className="space-y-4">
          <section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm shadow-neutral-100/70">
            <h3 className="text-base font-semibold text-neutral-950">How that will sound</h3>
            <p className="mt-1 text-xs leading-relaxed text-neutral-500">
              {pointOfViewSentence(strategy)}
            </p>
            <div className="mt-4 space-y-2">
              {LANE_META.map((lane) => (
                <div key={lane.id}>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="text-neutral-500">{lane.feeling}</span>
                    <span className="font-medium tabular-nums text-neutral-900">{strategy.discovery_mix[lane.id]}%</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-neutral-100">
                    <div
                      className="h-full rounded-full bg-neutral-900"
                      style={{ width: `${strategy.discovery_mix[lane.id]}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 rounded-lg bg-neutral-50 p-3 text-xs leading-relaxed text-neutral-500">
              {strategy.live_expansion === "catalog"
                ? "Close-to-core mode still allows careful surprises, but your strongest matches remain the station's center."
                : strategy.live_expansion === "live"
                  ? "Wide-open mode gives the next station a larger fresh Spotify discovery window."
                  : "Balanced-reach mode starts from strong matches and reserves room for fresh Spotify finds."}
            </div>
          </section>

          <section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm shadow-neutral-100/70">
            <h3 className="text-base font-semibold text-neutral-950">Top genres</h3>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {topGenres.map(({ genre, count }) => (
                <button
                  key={genre}
                  onClick={() => addGenre("boost", genre)}
                  className="rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-[11px] text-neutral-600 transition-colors hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-700"
                  title={`Boost ${genre}`}
                >
                  {genre} <span className="text-neutral-400">{count}</span>
                </button>
              ))}
            </div>
          </section>
        </aside>
      </section>

      <section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm shadow-neutral-100/70">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h3 className="text-base font-semibold text-neutral-950">Artist influence</h3>
            <p className="mt-1 text-xs leading-relaxed text-neutral-500">
              Add an artist's strongest genre to your boost or soften list.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search artists"
                className="min-h-[38px] w-full rounded-lg border border-neutral-200 px-3 py-2 text-xs focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 sm:w-64"
              />
            </div>
            <div className="flex gap-1">
              <SortButton active={sort === "az"} onClick={() => setSort("az")} label="A-Z" />
              <SortButton active={sort === "za"} onClick={() => setSort("za")} label="Z-A" />
            </div>
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {(search ? filtered : influenceArtists).map((artist) => (
            <ArtistCard
              key={artist.id}
              artist={artist}
              onBoost={(genre) => addGenre("boost", genre)}
              onAvoid={(genre) => addGenre("avoid", genre)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function SnapshotMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-neutral-100 bg-neutral-50 px-3 py-2">
      <p className="text-lg font-semibold tabular-nums text-neutral-950">{value.toLocaleString()}</p>
      <p className="text-[11px] text-neutral-500">{label}</p>
    </div>
  );
}

function ReadinessPill({ label, done, detail }: { label: string; done: boolean; detail: string }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-neutral-100 bg-neutral-50 px-3 py-2">
      <div>
        <p className="text-xs font-medium text-neutral-800">{label}</p>
        <p className="text-[11px] text-neutral-500">{detail}</p>
      </div>
      <span className={done ? "text-emerald-600" : "text-neutral-300"}>
        {done ? "Ready" : "Pending"}
      </span>
    </div>
  );
}

function GenreChipRow({
  genres,
  empty,
  tone,
  onRemove,
  onAdd,
}: {
  genres: string[];
  empty: string;
  tone: "boost" | "avoid" | "suggestion";
  onRemove?: (genre: string) => void;
  onAdd?: (genre: string) => void;
}) {
  if (genres.length === 0) {
    return empty ? <p className="text-xs text-neutral-400">{empty}</p> : null;
  }

  const className =
    tone === "boost"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : tone === "avoid"
        ? "border-amber-200 bg-amber-50 text-amber-700"
        : "border-neutral-200 bg-white text-neutral-500 hover:border-emerald-200 hover:text-emerald-700";

  return (
    <div className="flex flex-wrap gap-1.5">
      {genres.map((genre) => (
        <button
          key={genre}
          onClick={() => (onRemove ? onRemove(genre) : onAdd?.(genre))}
          className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${className}`}
          title={onRemove ? `Remove ${genre}` : `Boost ${genre}`}
        >
          {genre}
          {onRemove && <span className="ml-1 text-current/60">x</span>}
        </button>
      ))}
    </div>
  );
}

function MixSlider({
  label,
  help,
  feeling,
  value,
  onChange,
}: {
  label: string;
  help: string;
  feeling: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <div>
          <p className="text-xs font-medium text-neutral-800">{label}</p>
          <p className="text-[11px] text-neutral-500">
            {feeling}: {help}
          </p>
        </div>
        <span className="text-xs font-semibold tabular-nums text-neutral-900">{value}%</span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-neutral-900"
      />
    </div>
  );
}

function OptionGroup({
  title,
  options,
  value,
  onChange,
}: {
  title: string;
  options: Array<{ id: string; label: string; body: string }>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-neutral-900">{title}</p>
      <div className="space-y-1.5">
        {options.map((option) => {
          const active = value === option.id;
          return (
            <button
              key={option.id}
              onClick={() => onChange(option.id)}
              className={[
                "w-full rounded-lg border px-3 py-2 text-left transition-colors",
                active
                  ? "border-neutral-900 bg-neutral-900 text-white"
                  : "border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50",
              ].join(" ")}
            >
              <span className="block text-xs font-semibold">{option.label}</span>
              <span className={active ? "mt-0.5 block text-[11px] text-white/70" : "mt-0.5 block text-[11px] text-neutral-500"}>
                {option.body}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SortButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        "min-h-[38px] rounded-lg border px-3 text-xs font-medium transition-colors",
        active
          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
          : "border-neutral-200 bg-white text-neutral-500 hover:bg-neutral-50",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

function ArtistCard({
  artist,
  onBoost,
  onAvoid,
}: {
  artist: Artist;
  onBoost: (genre: string) => void;
  onAvoid: (genre: string) => void;
}) {
  const { playSingle } = usePlayer();
  const [playLoading, setPlayLoading] = useState(false);
  const primaryGenre = artist.genres[0] ? normalizeGenre(artist.genres[0]) : "";

  async function handlePlayArtist() {
    if (playLoading) return;
    setPlayLoading(true);
    try {
      const res = await fetch("/api/recommend-songs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: artist.name, limit: 1, use_taste_strategy: false }),
      });
      const body = await res.json().catch(() => ({}));
      const songs = body.results ?? body.songs ?? body.recommendations ?? [];
      if (songs.length > 0 && songs[0].spotify_track_id) {
        await playSingle({
          spotifyTrackId: songs[0].spotify_track_id,
          trackName: songs[0].track_name,
          artistName: songs[0].artist_name,
        });
      }
    } catch {}
    setPlayLoading(false);
  }

  return (
    <div className="rounded-lg border border-neutral-200 p-3 transition-colors hover:border-neutral-300">
      <div className="flex items-center gap-3">
        <button
          onClick={handlePlayArtist}
          disabled={playLoading}
          className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-neutral-100 text-neutral-400 disabled:opacity-50"
          title={`Play ${artist.name}`}
        >
          {artist.image_url ? (
            <img src={artist.image_url} alt={artist.name} className="h-full w-full object-cover" loading="lazy" />
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-neutral-900">{artist.name}</p>
          <p className="mt-0.5 truncate text-xs text-neutral-500">
            {artist.genres.length > 0 ? artist.genres.slice(0, 3).join(", ") : "No genres yet"}
          </p>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          onClick={() => primaryGenre && onBoost(primaryGenre)}
          disabled={!primaryGenre}
          className="min-h-[34px] rounded-lg border border-emerald-200 bg-emerald-50 px-2 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          More like this
        </button>
        <button
          onClick={() => primaryGenre && onAvoid(primaryGenre)}
          disabled={!primaryGenre}
          className="min-h-[34px] rounded-lg border border-neutral-200 bg-white px-2 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Less like this
        </button>
      </div>
    </div>
  );
}
