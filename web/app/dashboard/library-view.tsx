"use client";

import { useEffect, useState } from "react";

type Artist = {
  id: number;
  name: string;
  genres: string[];
  enriched: boolean;
  embedded: boolean;
};

type LibraryData = {
  stats: { artistCount: number; trackCount: number; recentPlayCount: number };
  artists: Artist[];
};

export default function LibraryView() {
  const [data, setData] = useState<LibraryData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/library")
      .then(async (res) => {
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(body.error ?? "Failed to load library");
        } else {
          setData(body);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Network error");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-6 w-72 bg-neutral-100 rounded animate-pulse" />
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="h-24 border border-neutral-200 rounded-md p-4 animate-pulse bg-neutral-50/40"
            />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="border border-red-200 bg-red-50 text-red-700 rounded-md p-4 text-sm">
        {error}
      </div>
    );
  }

  if (!data || data.artists.length === 0) {
    return (
      <div className="space-y-6">
        <Stats stats={{ artistCount: 0, trackCount: 0, recentPlayCount: 0 }} />
        <div className="border border-dashed border-neutral-300 rounded-xl p-12 text-center space-y-4">
          <div className="text-5xl">🎧</div>
          <div>
            <p className="text-base font-semibold text-neutral-800">
              Your library is empty
            </p>
            <p className="text-sm text-neutral-500 mt-1 max-w-xs mx-auto leading-relaxed">
              Sync your Spotify library to get started.
            </p>
          </div>
          <div className="flex items-center justify-center gap-2 text-sm text-neutral-400">
            <span>Use</span>
            <span className="font-medium text-neutral-600">&ldquo;Step 1 — Sync Library&rdquo;</span>
            <span>in the sidebar</span>
            <span className="text-lg">←</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Stats stats={data.stats} />
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
        {data.artists.map((a) => (
          <ArtistCard key={a.id} artist={a} />
        ))}
      </div>
    </div>
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
  return (
    <div className="border border-neutral-200 rounded-md p-3 hover:border-neutral-300 transition-colors">
      <div className="text-sm font-medium text-neutral-900 truncate">{artist.name}</div>
      <div className="mt-0.5 text-xs text-neutral-500 truncate min-h-[16px]">
        {artist.genres.length > 0 ? artist.genres.slice(0, 3).join(", ") : "-"}
      </div>
      <div className="mt-2 flex gap-1.5">
        <Badge on={artist.enriched} label="enriched" />
        <Badge on={artist.embedded} label="embedded" />
      </div>
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
