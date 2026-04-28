"use client";

import { useCallback, useEffect, useState } from "react";

type ViewSummary = {
  id: number;
  name: string;
  prompt: string;
  updatedAt: string;
};

type ViewItem = {
  artist_id: number;
  rank: number | null;
  reason: string | null;
  artist_name: string;
  genres: string[];
};

type ViewDetail = {
  id: number;
  name: string;
  prompt: string;
  updatedAt: string;
  items: ViewItem[];
};

export default function SavedView() {
  const [views, setViews] = useState<ViewSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<ViewDetail | null>(null);
  const [activeLoading, setActiveLoading] = useState(false);

  const fetchList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/views");
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to load views");
        return;
      }
      setViews(data.views ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchList();
    const handler = () => fetchList();
    window.addEventListener("views:changed", handler);
    return () => window.removeEventListener("views:changed", handler);
  }, [fetchList]);

  async function openView(id: number) {
    setActiveLoading(true);
    setActive(null);
    try {
      const res = await fetch(`/api/views/${id}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to load view");
        return;
      }
      setActive(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setActiveLoading(false);
    }
  }

  async function deleteView(id: number) {
    if (!window.confirm("Delete this view?")) return;
    try {
      const res = await fetch(`/api/views/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Delete failed");
        return;
      }
      if (active?.id === id) setActive(null);
      fetchList();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    }
  }

  if (loading) {
    return (
      <div className="space-y-2 max-w-2xl">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-12 border border-neutral-200 rounded animate-pulse bg-neutral-50/40"
          />
        ))}
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

  if (!views || views.length === 0) {
    return (
      <div className="border border-dashed border-neutral-300 rounded-xl p-12 text-center space-y-4 max-w-2xl">
        <div className="text-5xl">💾</div>
        <div>
          <p className="text-base font-semibold text-neutral-800">No saved views yet</p>
          <p className="text-sm text-neutral-500 mt-1 max-w-xs mx-auto leading-relaxed">
            Head to <span className="font-medium text-neutral-700">Discover</span>, run a query,
            and click <span className="font-medium text-neutral-700">&ldquo;Save view&rdquo;</span> to
            bookmark your favourite recommendation sets.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-[260px_1fr] gap-4 max-w-4xl">
      <ul className="border border-neutral-200 rounded-md divide-y divide-neutral-100">
        {views.map((v) => {
          const isActive = active?.id === v.id;
          return (
            <li
              key={v.id}
              className={[
                "px-3 py-3 md:py-2 cursor-pointer hover:bg-neutral-50 active:bg-neutral-100",
                isActive ? "bg-emerald-50/60" : "",
              ].join(" ")}
              onClick={() => openView(v.id)}
            >
              <div className="text-sm font-medium text-neutral-900 truncate">
                {v.name}
              </div>
              <div className="text-xs text-neutral-500 truncate">
                {v.prompt || "—"}
              </div>
            </li>
          );
        })}
      </ul>

      <div>
        {activeLoading && (
          <div className="text-sm text-neutral-400">Loading view…</div>
        )}
        {!activeLoading && !active && (
          <div className="border border-dashed border-neutral-300 rounded-md p-8 text-center text-sm text-neutral-500">
            Select a view to inspect its artists.
          </div>
        )}
        {!activeLoading && active && (
          <div className="space-y-3">
            <header className="flex items-baseline justify-between gap-2">
              <div>
                <h3 className="text-base font-semibold text-neutral-900">{active.name}</h3>
                {active.prompt && (
                  <p className="text-xs text-neutral-500 mt-0.5">"{active.prompt}"</p>
                )}
              </div>
              <button
                onClick={() => deleteView(active.id)}
                className="text-xs text-red-500 hover:text-red-700"
              >
                Delete
              </button>
            </header>
            {active.items.length === 0 ? (
              <div className="text-sm text-neutral-500">This view has no items.</div>
            ) : (
              <ul className="border border-neutral-200 rounded-md divide-y divide-neutral-100">
                {active.items.map((it) => (
                  <li key={it.artist_id} className="px-3 py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <div className="text-sm font-medium text-neutral-900 truncate">
                        {it.artist_name}
                      </div>
                      <div className="text-xs text-neutral-400 tabular-nums">
                        #{it.rank ?? "—"}
                      </div>
                    </div>
                    {it.genres.length > 0 && (
                      <div className="text-xs text-neutral-500 truncate">
                        {it.genres.slice(0, 3).join(", ")}
                      </div>
                    )}
                    {it.reason && (
                      <div className="text-xs text-neutral-600 mt-0.5">{it.reason}</div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
