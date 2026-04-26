"use client";

import { useState } from "react";

type SignalBreakdown = { affinity: number; context: number; editorial: number };
type Recommendation = {
  artist_id: string;
  artist_name: string;
  score: number;
  signals: SignalBreakdown;
  reasons: string[];
};

export default function DiscoverView() {
  const [prompt, setPrompt] = useState("");
  const [weights, setWeights] = useState({ affinity: 40, context: 40, editorial: 20 });
  const [results, setResults] = useState<Recommendation[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastQuery, setLastQuery] = useState<{
    prompt: string;
    weights: { affinity: number; context: number; editorial: number };
  } | null>(null);
  const [savedToast, setSavedToast] = useState<string | null>(null);

  async function handleSubmit() {
    setLoading(true);
    setError(null);
    try {
      const normalized = {
        affinity: weights.affinity / 100,
        context: weights.context / 100,
        editorial: weights.editorial / 100,
      };
      const res = await fetch(`/api/recommend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, weights: normalized }),
      });
      if (!res.ok) {
        setResults([]);
        setError(null);
        return;
      }
      const data = await res.json();
      setResults(data.results ?? []);
      setLastQuery({ prompt, weights: normalized });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveView() {
    if (!results || results.length === 0 || !lastQuery) return;

    const defaultName = lastQuery.prompt.trim() || "Untitled view";
    const name = window.prompt("Name this view", defaultName.slice(0, 60));
    if (!name) return;

    try {
      const res = await fetch("/api/views", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          prompt: lastQuery.prompt,
          weights: lastQuery.weights,
          items: results.map((r, i) => ({
            artist_id: Number(r.artist_id),
            rank: i + 1,
            reason: r.reasons[0] ?? null,
          })),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setSavedToast(`Save failed: ${body.error ?? body.detail ?? res.status}`);
      } else {
        setSavedToast("Saved");
        window.dispatchEvent(new CustomEvent("views:changed"));
      }
    } catch (err) {
      setSavedToast(err instanceof Error ? err.message : "Network error");
    } finally {
      setTimeout(() => setSavedToast(null), 2500);
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="space-y-3">
        <input
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Find me something like…"
          className="w-full px-3 py-2 border border-neutral-200 rounded-md text-sm focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
        />

        <div className="grid grid-cols-3 gap-4 pt-1">
          <Slider
            label="Affinity"
            value={weights.affinity}
            onChange={(v) => setWeights({ ...weights, affinity: v })}
          />
          <Slider
            label="Context"
            value={weights.context}
            onChange={(v) => setWeights({ ...weights, context: v })}
          />
          <Slider
            label="Editorial"
            value={weights.editorial}
            onChange={(v) => setWeights({ ...weights, editorial: v })}
          />
        </div>

        <div className="flex justify-end items-center gap-2">
          {results && results.length > 0 && lastQuery && (
            <button
              onClick={handleSaveView}
              className="px-3 py-1.5 rounded-md border border-neutral-200 bg-white text-xs text-neutral-700 hover:bg-neutral-50 hover:border-neutral-300"
            >
              Save view
            </button>
          )}
          <button
            onClick={handleSubmit}
            disabled={loading}
            className="px-4 py-1.5 rounded-md bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "Thinking…" : "Get recommendations"}
          </button>
        </div>
        {savedToast && (
          <div className="text-right text-[11px] text-emerald-600">{savedToast}</div>
        )}
      </div>

      <div>
        {error && (
          <div className="border border-red-200 bg-red-50 text-red-700 rounded-md p-3 text-sm mb-3">
            {error}
          </div>
        )}

        {results === null ? (
          <EmptyState
            title="No recommendations yet"
            body="Your library needs to be enriched and embedded first."
          />
        ) : results.length === 0 ? (
          <EmptyState
            title="Nothing to show"
            body="The recommend endpoint returned no results — your library may need to be enriched and embedded first."
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {results.map((r) => (
              <RecommendationCard
                key={r.artist_id}
                rec={r}
                prompt={lastQuery?.prompt ?? ""}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Slider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <div className="flex items-center justify-between text-xs text-neutral-600 mb-1">
        <span>{label}</span>
        <span className="tabular-nums text-neutral-400">{value}</span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-emerald-600"
      />
    </label>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="border border-dashed border-neutral-300 rounded-md p-8 text-center">
      <div className="text-sm font-medium text-neutral-700">{title}</div>
      <div className="text-xs text-neutral-500 mt-1">{body}</div>
    </div>
  );
}

function RecommendationCard({
  rec,
  prompt,
}: {
  rec: Recommendation;
  prompt: string;
}) {
  const [synthState, setSynthState] = useState<
    | { status: "idle" }
    | { status: "loading" }
    | { status: "ready"; paragraph: string }
    | { status: "error"; message: string }
  >({ status: "idle" });

  async function loadSynthesis() {
    setSynthState({ status: "loading" });
    try {
      const res = await fetch("/api/synthesize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          artist_id: Number(rec.artist_id),
          prompt: prompt || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSynthState({
          status: "error",
          message: data.error ?? data.detail ?? `HTTP ${res.status}`,
        });
        return;
      }
      setSynthState({ status: "ready", paragraph: data.paragraph ?? "" });
    } catch (err) {
      setSynthState({
        status: "error",
        message: err instanceof Error ? err.message : "Network error",
      });
    }
  }

  return (
    <div className="border border-neutral-200 rounded-md p-4 space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-sm font-medium text-neutral-900 truncate">{rec.artist_name}</div>
        <div className="text-xs text-neutral-500 tabular-nums">{rec.score.toFixed(2)}</div>
      </div>
      <div className="space-y-1">
        <SignalBar label="A" value={rec.signals.affinity} />
        <SignalBar label="C" value={rec.signals.context} />
        <SignalBar label="E" value={rec.signals.editorial} />
      </div>
      {rec.reasons.length > 0 && (
        <ul className="text-xs text-neutral-600 space-y-0.5 list-disc list-inside">
          {rec.reasons.slice(0, 3).map((r, i) => (
            <li key={i} className="truncate">{r}</li>
          ))}
        </ul>
      )}
      <div className="pt-1 border-t border-neutral-100">
        {synthState.status === "idle" && (
          <button
            onClick={loadSynthesis}
            className="text-xs text-emerald-700 hover:text-emerald-800"
          >
            Why this?
          </button>
        )}
        {synthState.status === "loading" && (
          <div className="text-xs text-neutral-400">Synthesizing…</div>
        )}
        {synthState.status === "ready" && (
          <p className="text-xs text-neutral-700 leading-relaxed">{synthState.paragraph}</p>
        )}
        {synthState.status === "error" && (
          <div className="text-xs text-red-500">{synthState.message}</div>
        )}
      </div>
    </div>
  );
}

function SignalBar({ label, value }: { label: string; value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="flex items-center gap-2 text-[10px] text-neutral-500">
      <span className="w-3">{label}</span>
      <div className="flex-1 h-1 bg-neutral-100 rounded">
        <div
          className="h-1 bg-emerald-500 rounded"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
