"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePlayer } from "./player-context";
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
  artists: Artist[];
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
  live_expansion: "auto" | "catalog" | "live";
  freshness: "newer" | "balanced" | "timeless";
};

type SortKey = "az" | "za";
type LaneKey = keyof DiscoveryMix;

const DEFAULT_STRATEGY: TasteStrategy = {
  genre_boosts: [],
  genre_avoids: [],
  discovery_mix: { deep_cuts: 38, popular: 38, radio_hits: 24 },
  live_expansion: "auto",
  freshness: "balanced",
};

const LANE_META: Array<{ id: LaneKey; label: string; help: string }> = [
  { id: "deep_cuts", label: "Deep cuts", help: "Lower-popularity finds and new-to-you artists" },
  { id: "popular", label: "Popular", help: "Known, but less obvious songs" },
  { id: "radio_hits", label: "Radio hits", help: "Recognizable anchors that keep stations grounded" },
];

const LIVE_OPTIONS: Array<{ id: TasteStrategy["live_expansion"]; label: string; body: string }> = [
  { id: "auto", label: "Auto", body: "Use live Spotify when the catalog needs help." },
  { id: "catalog", label: "Catalog first", body: "Prefer modeled MusicLife matches." },
  { id: "live", label: "Fresh reach", body: "Expand outside the catalog more often." },
];

const FRESHNESS_OPTIONS: Array<{ id: TasteStrategy["freshness"]; label: string; body: string }> = [
  { id: "newer", label: "Newer", body: "Tilt toward recent releases and fresh context." },
  { id: "balanced", label: "Balanced", body: "Blend new songs with durable favorites." },
  { id: "timeless", label: "Timeless", body: "Let older high-confidence songs compete." },
];

function normalizeGenre(value: string): string {
  return value.trim().toLowerCase().slice(0, 48);
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

function sameStrategy(a: TasteStrategy, b: TasteStrategy): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export default function LibraryView({
  onSetupComplete,
}: {
  onSetupComplete?: () => void;
}) {
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
            Connect your Spotify library to build the taste profile that powers Radio.
          </p>
        </div>
        <SetupAllButton onProgress={fetchLibrary} onComplete={onSetupComplete} />
        <div className="space-y-2.5 pt-1">
          {[
            { n: 1, title: "Sync library", desc: "Import artists and listening history" },
            { n: 2, title: "Enrich artists", desc: "Fetch genres, tags, and metadata" },
            { n: 3, title: "Generate embeddings", desc: "Build taste vectors for matching" },
            { n: 4, title: "Sync sources", desc: "Add editorial context and reviews" },
            { n: 5, title: "Populate tracks", desc: "Fetch playable songs for Radio" },
            { n: 6, title: "Model songs", desc: "Build song-level context for fresher lanes" },
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
              Shape what MusicLife recommends next.
            </h3>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-neutral-500">
              Your Spotify history builds the model. These strategy controls tell Radio how adventurous, current, and genre-focused to be.
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

        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <SnapshotMetric label="Artists" value={data.stats.artistCount} />
          <SnapshotMetric label="Saved tracks" value={data.stats.trackCount} />
          <SnapshotMetric label="Recent plays" value={data.stats.recentPlayCount} />
          <SnapshotMetric label="Modeled songs" value={data.stats.modeledTrackCount} />
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          <ReadinessPill label="Taste model" done={data.readiness.steps.embedded} detail={`${data.readiness.embeddedCount}/${data.readiness.requiredArtistCount} artists`} />
          <ReadinessPill label="Song catalog" done={data.readiness.steps.tracks} detail={`${data.readiness.playableTrackCount}/${data.readiness.requiredPlayableTrackCount} playable`} />
          <ReadinessPill label="Music context" done={data.readiness.steps.context} detail={`${data.stats.mentionCount.toLocaleString()} mentions`} />
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
        <div className="space-y-4 rounded-lg border border-neutral-200 bg-white p-4 shadow-sm shadow-neutral-100/70">
          <div>
            <h3 className="text-base font-semibold text-neutral-950">Discovery strategy</h3>
            <p className="mt-1 text-xs leading-relaxed text-neutral-500">
              Saved strategy applies to Radio when you start from Taste radio. Typed prompts still steer that run directly.
            </p>
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
              <p className="text-sm font-medium text-neutral-900">Discovery mix</p>
              <p className="text-xs text-neutral-500">Set the default lane balance for unprompted Radio sessions.</p>
            </div>
            {LANE_META.map((lane) => (
              <MixSlider
                key={lane.id}
                label={lane.label}
                help={lane.help}
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
              title="Live Spotify expansion"
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
            <h3 className="text-base font-semibold text-neutral-950">Next Radio preview</h3>
            <p className="mt-1 text-xs leading-relaxed text-neutral-500">
              The next unprompted station will use this shape before track-level feedback and novelty checks.
            </p>
            <div className="mt-4 space-y-2">
              {LANE_META.map((lane) => (
                <div key={lane.id}>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="text-neutral-500">{lane.label}</span>
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
                ? "Catalog-first mode explains why Live Spotify can stay at 0 when modeled matches are strong."
                : strategy.live_expansion === "live"
                  ? "Fresh reach mode will look outside the catalog more aggressively."
                  : "Auto mode keeps live Spotify in reserve until the catalog needs expansion."}
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
  value,
  onChange,
}: {
  label: string;
  help: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <div>
          <p className="text-xs font-medium text-neutral-800">{label}</p>
          <p className="text-[11px] text-neutral-500">{help}</p>
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

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <StatusBadge on={artist.enriched} label="enriched" />
        <StatusBadge on={artist.embedded} label="embedded" />
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

function StatusBadge({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      className={[
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px]",
        on
          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
          : "border-neutral-200 bg-neutral-50 text-neutral-400",
      ].join(" ")}
    >
      <span className={on ? "h-1 w-1 rounded-full bg-emerald-500" : "h-1 w-1 rounded-full bg-neutral-300"} />
      {label}
    </span>
  );
}
