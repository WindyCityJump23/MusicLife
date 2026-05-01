"use client";

import { useCallback, useEffect, useState } from "react";
import SetupAllButton from "./SetupAllButton";

type Artist = {
  id: number;
  name: string;
  genres: string[];
  enriched: boolean;
  embedded: boolean;
  image_url: string | null;
};

type LibraryData = {
  stats: { artistCount: number; trackCount: number; recentPlayCount: number };
  artists: Artist[];
};

type SortKey = "az" | "za";

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

  const fetchLibrary = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch("/api/library")
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) {
          setError(body.error ?? "Failed to load library");
        } else {
          setData(body);
        }
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

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-6 w-72 bg-neutral-100 rounded animate-pulse" />
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="h-24 border border-neutral-200 rounded-md p-4 skeleton-shimmer"
            />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="border border-red-200 bg-red-50 text-red-700 rounded-md p-4 text-sm flex items-center justify-between gap-3">
        <span>{error}</span>
        <button
          onClick={fetchLibrary}
          className="shrink-0 px-3 py-1.5 rounded-lg border border-red-200 text-red-600 text-xs font-medium hover:bg-red-100 transition-colors"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!data || data.artists.length === 0) {
    return (
      <div className="max-w-sm mx-auto py-8 space-y-6">
        <div className="text-center space-y-2">
          <div className="text-5xl">🎧</div>
          <h2 className="text-lg font-semibold text-neutral-900">Welcome to MusicLife</h2>
          <p className="text-sm text-neutral-500 leading-relaxed">
            Connect your Spotify library to get personalised recommendations.
            Takes 2–5 minutes and runs in the background.
          </p>
        </div>
        <SetupAllButton
          onProgress={fetchLibrary}
          onComplete={onSetupComplete}
        />
        <div className="space-y-2.5 pt-1">
          {[
            { n: 1, title: "Sync Library",          desc: "Import your artists & listening history" },
            { n: 2, title: "Enrich Artists",         desc: "Fetch genres, tags & metadata" },
            { n: 3, title: "Generate Embeddings",    desc: "Build AI taste vectors for smart matching" },
            { n: 4, title: "Sync Sources",           desc: "Add editorial content & reviews" },
            { n: 5, title: "Populate Tracks",        desc: "Fetch songs for Discover" },
          ].map(({ n, title, desc }) => (
            <div key={n} className="flex items-start gap-2.5">
              <div className="shrink-0 w-5 h-5 rounded-full bg-neutral-200 flex items-center justify-center text-[10px] font-bold text-neutral-500 mt-0.5">
                {n}
              </div>
              <div>
                <p className="text-xs font-medium text-neutral-800 leading-tight">{title}</p>
                <p className="text-[10px] text-neutral-400 leading-snug mt-0.5">{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Filter & sort
  const filtered = data.artists
    .filter((a) =>
      a.name.toLowerCase().includes(search.toLowerCase())
    )
    .sort((a, b) =>
      sort === "az"
        ? a.name.localeCompare(b.name)
        : b.name.localeCompare(a.name)
    );

  return (
    <div className="space-y-4">
      <Stats stats={data.stats} />

      {/* Search + Sort controls */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="flex-1 relative">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search artists…"
            className="w-full pl-9 pr-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 placeholder:text-neutral-400"
          />
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
        </div>
        <div className="flex gap-1">
          <SortButton active={sort === "az"} onClick={() => setSort("az")} label="A → Z" />
          <SortButton active={sort === "za"} onClick={() => setSort("za")} label="Z → A" />
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-neutral-400 text-center py-8">
          No artists match &ldquo;{search}&rdquo;
        </p>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
          {filtered.map((a) => (
            <ArtistCard key={a.id} artist={a} />
          ))}
        </div>
      )}
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
        "px-3 py-2 rounded-lg text-xs font-medium border transition-colors",
        active
          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
          : "border-neutral-200 bg-white text-neutral-500 hover:bg-neutral-50",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

function Stats({
  stats,
}: {
  stats: { artistCount: number; trackCount: number; recentPlayCount: number };
}) {
  return (
    <header className="flex flex-wrap items-baseline gap-x-1 gap-y-0.5 text-sm text-neutral-600">
      <span className="font-medium text-neutral-900">{stats.artistCount}</span>
      <span>artists,</span>
      <span className="font-medium text-neutral-900">{stats.trackCount}</span>
      <span>tracks,</span>
      <span className="font-medium text-neutral-900">{stats.recentPlayCount}</span>
      <span>plays in the last 50.</span>
    </header>
  );
}

function ArtistCard({ artist }: { artist: Artist }) {
  const [expanded, setExpanded] = useState(false);
  const spotifySearchUrl = `https://open.spotify.com/search/${encodeURIComponent(artist.name)}`;

  return (
    <div
      className="border border-neutral-200 rounded-md p-3 hover:border-neutral-300 transition-colors cursor-pointer"
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-center gap-2.5">
        {/* Artist thumbnail */}
        <div className="shrink-0 w-10 h-10 rounded-full bg-neutral-100 overflow-hidden flex items-center justify-center">
          {artist.image_url ? (
            <img
              src={artist.image_url}
              alt={artist.name}
              className="w-full h-full object-cover"
              loading="lazy"
            />
          ) : (
            <span className="text-lg text-neutral-300">🎵</span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-neutral-900 truncate">{artist.name}</div>
          <div className="mt-0.5 text-xs text-neutral-500 truncate min-h-[16px]">
            {artist.genres.length > 0 ? artist.genres.slice(0, 3).join(", ") : "—"}
          </div>
        </div>
      </div>

      <div className="mt-2 flex gap-1.5">
        <Badge on={artist.enriched} label="enriched" />
        <Badge on={artist.embedded} label="embedded" />
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="mt-3 pt-3 border-t border-neutral-100 space-y-2">
          {artist.genres.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {artist.genres.map((g) => (
                <span
                  key={g}
                  className="text-[10px] text-neutral-500 bg-neutral-100 rounded-full px-2 py-0.5 capitalize"
                >
                  {g}
                </span>
              ))}
            </div>
          )}
          <a
            href={spotifySearchUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1.5 text-[11px] text-[#1DB954] hover:underline font-medium"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
            </svg>
            Open in Spotify
          </a>
        </div>
      )}
    </div>
  );
}

function Badge({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      className={[
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] border",
        on
          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
          : "border-neutral-200 bg-neutral-50 text-neutral-400",
      ].join(" ")}
    >
      <span
        className={[
          "h-1 w-1 rounded-full",
          on ? "bg-emerald-500" : "bg-neutral-300",
        ].join(" ")}
      />
      {label}
    </span>
  );
}
