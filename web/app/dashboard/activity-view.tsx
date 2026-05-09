"use client";

import { useCallback, useEffect, useState } from "react";

type Play = {
  id: number;
  listenedAt: string;
  trackName: string;
  artistName: string;
};

export default function ActivityView() {
  const [plays, setPlays] = useState<Play[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchActivity = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch("/api/activity")
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) {
          setError(body.error ?? "Failed to load activity");
        } else {
          setPlays(body.plays ?? []);
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
    fetchActivity();
  }, [fetchActivity]);

  if (loading) {
    return (
      <div className="space-y-2 max-w-2xl">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="h-10 border border-neutral-200 rounded skeleton-shimmer"
          />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="border border-red-200 bg-red-50 text-red-700 rounded-md p-4 text-sm flex items-center justify-between gap-3">
        <span>{error}</span>
        <button
          onClick={fetchActivity}
          className="shrink-0 px-3 py-1.5 rounded-lg border border-red-200 text-red-600 text-xs font-medium hover:bg-red-100 transition-colors"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!plays || plays.length === 0) {
    return (
      <div className="border border-dashed border-neutral-300 rounded-xl p-12 text-center space-y-4 max-w-2xl">
        <div className="text-5xl">📊</div>
        <div>
          <p className="text-base font-semibold text-neutral-800">No activity yet</p>
          <p className="text-sm text-neutral-500 mt-1 max-w-xs mx-auto leading-relaxed">
            Your recent Spotify plays will appear here after you sync your library.
          </p>
        </div>
        <div className="flex items-center justify-center gap-2 text-sm text-neutral-400">
          <span>Run</span>
          <span className="font-medium text-neutral-600">&ldquo;Step 1 — Sync Library&rdquo;</span>
          <span>in the sidebar to get started</span>
          <span className="text-lg">←</span>
        </div>
      </div>
    );
  }

  return (
    <ul className="border border-neutral-200 rounded-md divide-y divide-neutral-100 max-w-2xl">
      {plays.map((p) => (
        <li
          key={p.id}
          className="flex items-center justify-between gap-2 px-3 py-2.5 text-sm hover:bg-neutral-50 group"
        >
          <div className="min-w-0 flex-1 pr-2">
            <div className="truncate text-neutral-900">{p.trackName}</div>
            <div className="truncate text-xs text-neutral-500">{p.artistName}</div>
          </div>
          <div className="text-xs text-neutral-400 tabular-nums whitespace-nowrap">
            {formatTime(p.listenedAt)}
          </div>
        </li>
      ))}
    </ul>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diffMin = Math.floor((now - d.getTime()) / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 7) return `${diffD}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
