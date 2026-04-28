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
      {plays.map((p) => {
        const spotifyUrl = `https://open.spotify.com/search/${encodeURIComponent(
          `${p.trackName} ${p.artistName}`
        )}`;
        return (
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
            {/* Spotify link */}
            <a
              href={spotifyUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="Open in Spotify"
              className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-neutral-300 hover:text-[#1DB954] transition-colors opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
              </svg>
            </a>
          </li>
        );
      })}
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
