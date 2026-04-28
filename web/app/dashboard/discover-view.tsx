"use client";

import { useState } from "react";
import { usePlayer } from "./player-context";

type SignalBreakdown = { affinity: number; context: number; editorial: number };
type TopMention = { source: string; excerpt: string; published_at: string };
type Recommendation = {
  artist_id: string;
  artist_name: string;
  score: number;
  signals: SignalBreakdown;
  reasons: string[];
  genres: string[];
  mention_count: number;
  top_mention: TopMention | null;
};

export default function DiscoverView({ onNavigate }: { onNavigate?: (view: string) => void }) {
  const [prompt, setPrompt] = useState("");
  const [weights, setWeights] = useState({ affinity: 40, context: 40, editorial: 20 });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [results, setResults] = useState<Recommendation[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playlistState, setPlaylistState] = useState<"idle" | "saving" | "done" | "error">("idle");
  const [playlistUrl, setPlaylistUrl] = useState<string | null>(null);
  const [playlistError, setPlaylistError] = useState<string | null>(null);
  const [playlistErrorDetail, setPlaylistErrorDetail] = useState<{
    detail?: string | null;
    endpoint?: string | null;
    spotify_status?: number | null;
    scope_issue?: boolean;
  } | null>(null);
  const [playlistStats, setPlaylistStats] = useState<{ added: number; failed: string[] } | null>(null);

  async function handleSubmit() {
    setLoading(true);
    setError(null);
    setPlaylistState("idle");
    setPlaylistUrl(null);
    setPlaylistError(null);
    setPlaylistErrorDetail(null);
    setPlaylistStats(null);
    try {
      const normalized = {
        affinity: weights.affinity / 100,
        context: weights.context / 100,
        editorial: weights.editorial / 100,
      };
      const res = await fetch(`/api/recommend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: prompt || null, weights: normalized }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? data.detail ?? "Failed to get recommendations");
        setResults([]);
        return;
      }
      setResults(data.results ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-5">
      {/* Search */}
      <div className="space-y-2">
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            placeholder="What are you in the mood for? (e.g. chill lo-fi, 90s rock…)"
            inputMode="text"
            enterKeyHint="search"
            className="flex-1 px-4 py-3 sm:py-2.5 border border-neutral-200 rounded-lg text-base sm:text-sm focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 placeholder:text-neutral-400"
          />
          <button
            onClick={handleSubmit}
            disabled={loading}
            className="px-5 py-3 sm:py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 active:bg-emerald-800 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
          >
            {loading ? "Finding…" : "Discover"}
          </button>
        </div>

        {/* Advanced toggle */}
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="text-[11px] text-neutral-400 hover:text-neutral-600"
        >
          {showAdvanced ? "▾ Hide tuning" : "▸ Tune weights"}
        </button>
        {showAdvanced && (
          <div className="space-y-3 pt-1 pb-2">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
              <WeightSlider label="Taste" hint="How close to your listening DNA" value={weights.affinity} onChange={(v) => setWeights({ ...weights, affinity: v })} />
              <WeightSlider label="Mood" hint="Vibe match from editorial context" value={weights.context} onChange={(v) => setWeights({ ...weights, context: v })} />
              <WeightSlider label="Buzz" hint="Currently talked about in press" value={weights.editorial} onChange={(v) => setWeights({ ...weights, editorial: v })} />
            </div>
            <p className="text-[10px] text-neutral-400 leading-relaxed">
              🎲 Results shuffle each time you hit Discover. Artists you&apos;ve already saved to playlists are ranked lower.
            </p>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="border border-red-200 bg-red-50 text-red-700 rounded-lg p-3 text-sm">
          {error}
        </div>
      )}

      {/* Results */}
      {results === null ? (
        <EmptyInitial />
      ) : results.length === 0 && !error ? (
        <EmptyNoResults />
      ) : results.length > 0 ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-neutral-400">
              {results.length} artist{results.length !== 1 ? "s" : ""} found
            </p>
            <SavePlaylistButton
              artists={results.map((r) => r.artist_name)}
              prompt={prompt}
              state={playlistState}
              onSave={async () => {
                setPlaylistState("saving");
                setPlaylistError(null);
                setPlaylistErrorDetail(null);
                setPlaylistUrl(null);
                setPlaylistStats(null);
                try {
                  const now = new Date();
                  const dateStr = now.toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  });
                  const name = prompt
                    ? `MusicLife: ${prompt.slice(0, 40)}${prompt.length > 40 ? "…" : ""}`
                    : `MusicLife Discover — ${dateStr}`;
                  const description = prompt
                    ? `"${prompt}" — Personalized by MusicLife on ${dateStr}`
                    : `Personalized discovery playlist by MusicLife — ${dateStr}`;

                  const res = await fetch("/api/playlist", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      artists: results.map((r) => r.artist_name),
                      name,
                      description,
                    }),
                  });
                  const data = await res.json().catch(() => ({}));
                  if (!res.ok) {
                    setPlaylistState("error");
                    setPlaylistError(data.error ?? "Failed to create playlist");
                    setPlaylistErrorDetail({
                      detail: data.detail ?? null,
                      endpoint: data.endpoint ?? null,
                      spotify_status: data.spotify_status ?? null,
                      scope_issue: !!data.scope_issue,
                    });
                    return;
                  }
                  setPlaylistState("done");
                  setPlaylistUrl(data.playlist_url);
                  setPlaylistStats({
                    added: data.tracks_added,
                    failed: data.tracks_failed ?? [],
                  });
                } catch (err) {
                  setPlaylistState("error");
                  setPlaylistError(
                    err instanceof Error ? err.message : "Network error"
                  );
                }
              }}
            />
          </div>

          {/* Playlist success banner */}
          {playlistState === "done" && playlistUrl && (
            <div className="border border-emerald-200 bg-emerald-50 rounded-lg p-3 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
              <div className="flex items-start gap-2 flex-1 min-w-0">
                <span className="text-lg">🎉</span>
                <p className="text-sm font-medium text-emerald-800">
                  Playlist created!
                  {playlistStats && (
                    <span className="font-normal text-emerald-600">
                      {" "}— {playlistStats.added} track{playlistStats.added !== 1 ? "s" : ""} added
                      {playlistStats.failed.length > 0 && (
                        <>, {playlistStats.failed.length} skipped</>
                      )}
                    </span>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0 flex-wrap">
                {onNavigate && (
                  <button
                    onClick={() => onNavigate("playlists")}
                    className="px-3 py-1.5 rounded-lg border border-emerald-200 text-emerald-700 text-xs font-medium hover:bg-emerald-100 transition-colors"
                  >
                    View in Playlists →
                  </button>
                )}
                <a
                  href={playlistUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-1.5 rounded-lg bg-[#1DB954] text-white text-xs font-medium hover:bg-[#1aa34a] transition-colors flex items-center gap-1.5"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
                  </svg>
                  Open in Spotify
                </a>
              </div>
            </div>
          )}

          {/* Playlist error banner */}
          {playlistState === "error" && playlistError && (
            <div className="border border-red-200 bg-red-50 rounded-lg p-3 flex items-start gap-2">
              <span className="text-sm leading-5 mt-px">⚠️</span>
              <div className="flex-1 min-w-0 space-y-1">
                <p className="text-sm text-red-700">{playlistError}</p>
                {playlistErrorDetail && (playlistErrorDetail.detail || playlistErrorDetail.endpoint) && (
                  <p className="text-[11px] text-red-500/80 font-mono break-words">
                    {playlistErrorDetail.endpoint && (
                      <span>{playlistErrorDetail.endpoint}</span>
                    )}
                    {playlistErrorDetail.spotify_status && (
                      <span> · {playlistErrorDetail.spotify_status}</span>
                    )}
                    {playlistErrorDetail.detail && (
                      <span className="block mt-0.5">“{playlistErrorDetail.detail}”</span>
                    )}
                  </p>
                )}
                {playlistErrorDetail?.scope_issue && (
                  <a
                    href="/api/auth/login"
                    className="inline-block text-[11px] text-red-700 underline hover:text-red-900"
                  >
                    Re-authorize Spotify →
                  </a>
                )}
              </div>
              <button
                onClick={() => {
                  setPlaylistState("idle");
                  setPlaylistError(null);
                  setPlaylistErrorDetail(null);
                }}
                aria-label="Dismiss error"
                className="text-xs text-red-400 hover:text-red-600 -mt-1 -mr-1 w-7 h-7 rounded flex items-center justify-center"
              >
                ✕
              </button>
            </div>
          )}

          <div className="border border-neutral-200 rounded-lg overflow-hidden divide-y divide-neutral-100">
            {results.map((r, i) => (
              <ArtistRow key={r.artist_id} rec={r} rank={i + 1} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/*  Artist Row                                                    */
/* ═══════════════════════════════════════════════════════════════ */

function ArtistRow({ rec, rank }: { rec: Recommendation; rank: number }) {
  const { playArtist } = usePlayer();
  const [playState, setPlayState] = useState<"idle" | "loading">("idle");
  const [expanded, setExpanded] = useState(false);

  const matchPct = Math.round(rec.score * 100);
  const spotifyUrl = `https://open.spotify.com/search/${encodeURIComponent(rec.artist_name)}`;

  async function handlePlay() {
    setPlayState("loading");
    const result = await playArtist(rec.artist_name);
    setPlayState("idle");
    if (!result.ok) {
      // Fallback: open Spotify search in new tab
      window.open(spotifyUrl, "_blank", "noopener");
    }
  }

  return (
    <div className="group">
      <div className="flex items-center gap-2 sm:gap-3 px-2.5 sm:px-3 py-2.5 hover:bg-neutral-50 transition-colors">
        {/* Rank */}
        <span className="w-5 sm:w-6 text-right text-xs tabular-nums text-neutral-300 font-medium shrink-0">
          {rank}
        </span>

        {/* Artist info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-neutral-900 truncate">
              {rec.artist_name}
            </span>
            {rec.genres && rec.genres.length > 0 && (
              <span className="hidden sm:inline text-[10px] text-neutral-400 truncate">
                {rec.genres.slice(0, 2).join(" · ")}
              </span>
            )}
          </div>
          {/* Genres on mobile (since they're hidden in the title row) */}
          {rec.genres && rec.genres.length > 0 && (
            <p className="sm:hidden text-[10px] text-neutral-400 truncate mt-0.5">
              {rec.genres.slice(0, 2).join(" · ")}
            </p>
          )}
          {/* Reason line */}
          {rec.reasons.length > 0 && (
            <p className="text-[11px] text-neutral-400 truncate mt-0.5">
              {rec.reasons[0]}
            </p>
          )}
        </div>

        {/* Match score badge */}
        <div
          className="shrink-0 w-9 h-9 sm:w-10 sm:h-10 rounded-full flex items-center justify-center text-xs font-bold"
          style={{
            background: matchPct > 70
              ? "linear-gradient(135deg, #059669, #10b981)"
              : matchPct > 40
              ? "linear-gradient(135deg, #d97706, #f59e0b)"
              : "linear-gradient(135deg, #9ca3af, #d1d5db)",
            color: matchPct > 40 ? "white" : "#374151",
          }}
          title={`Match score: ${matchPct}%`}
        >
          {matchPct}
        </div>

        {/* Play button */}
        <button
          onClick={handlePlay}
          disabled={playState === "loading"}
          aria-label={`Play ${rec.artist_name}`}
          title={`Play ${rec.artist_name}`}
          className="shrink-0 w-9 h-9 sm:w-8 sm:h-8 rounded-full flex items-center justify-center bg-neutral-900 text-white hover:bg-neutral-700 active:scale-95 transition-all disabled:opacity-40"
        >
          {playState === "loading" ? (
            <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <circle cx="12" cy="12" r="10" strokeOpacity="0.3" />
              <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
            </svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

        {/* Spotify link */}
        <a
          href={spotifyUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open in Spotify"
          title="Open in Spotify"
          className="hidden sm:inline-flex shrink-0 text-neutral-300 hover:text-[#1DB954] transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
          </svg>
        </a>

        {/* Expand toggle */}
        {(rec.top_mention || rec.reasons.length > 1) && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="shrink-0 w-7 h-7 flex items-center justify-center text-neutral-300 hover:text-neutral-500 transition-colors text-xs"
            aria-label={expanded ? "Collapse details" : "Expand details"}
            title="More info"
          >
            {expanded ? "▾" : "▸"}
          </button>
        )}
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="px-3 pb-3 pl-9 sm:pl-12 space-y-2">
          {/* All reasons */}
          {rec.reasons.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {rec.reasons.map((r, i) => (
                <span key={i} className="text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-full px-2 py-0.5">
                  {r}
                </span>
              ))}
              {rec.mention_count > 0 && (
                <span className="text-[10px] text-neutral-500 bg-neutral-50 border border-neutral-100 rounded-full px-2 py-0.5">
                  {rec.mention_count} mention{rec.mention_count !== 1 ? "s" : ""}
                </span>
              )}
            </div>
          )}
          {/* Editorial excerpt */}
          {rec.top_mention?.excerpt && (
            <div className="bg-neutral-50 border border-neutral-100 rounded-md px-3 py-2">
              <p className="text-[11px] text-neutral-600 leading-relaxed line-clamp-2 italic">
                &ldquo;{rec.top_mention.excerpt}&rdquo;
              </p>
              {rec.top_mention.source && (
                <p className="text-[10px] text-neutral-400 mt-1">
                  — {rec.top_mention.source}
                </p>
              )}
            </div>
          )}
          {/* Genre pills */}
          {rec.genres && rec.genres.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {rec.genres.slice(0, 5).map((g) => (
                <span key={g} className="text-[10px] text-neutral-500 bg-neutral-100 rounded-full px-2 py-0.5 capitalize">
                  {g}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/*  Small components                                              */
/* ═══════════════════════════════════════════════════════════════ */

function WeightSlider({ label, hint, value, onChange }: { label: string; hint?: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="block">
      <div className="flex items-center justify-between text-xs text-neutral-600 mb-1">
        <span className="font-medium" title={hint}>{label}</span>
        <span className="tabular-nums text-neutral-400">{value}%</span>
      </div>
      {hint && <p className="text-[9px] text-neutral-400 mb-1.5 leading-tight">{hint}</p>}
      <input type="range" min={0} max={100} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-emerald-600" />
    </label>
  );
}

function EmptyInitial() {
  return (
    <div className="border border-dashed border-neutral-200 rounded-xl p-12 text-center space-y-3">
      <div className="text-4xl">🎧</div>
      <div>
        <p className="text-sm font-medium text-neutral-700">Discover new music</p>
        <p className="text-xs text-neutral-400 mt-1 max-w-xs mx-auto leading-relaxed">
          Describe what you&apos;re in the mood for, or just hit <strong>Discover</strong> to see what matches your taste.
        </p>
      </div>
    </div>
  );
}

function EmptyNoResults() {
  return (
    <div className="border border-dashed border-neutral-200 rounded-xl p-12 text-center space-y-3">
      <div className="text-4xl">🎻</div>
      <div>
        <p className="text-sm font-medium text-neutral-700">No results</p>
        <p className="text-xs text-neutral-400 mt-1 max-w-xs mx-auto">
          Make sure you&apos;ve synced, enriched, and embedded your library first.
        </p>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/*  Save as Playlist button                                       */
/* ═══════════════════════════════════════════════════════════════ */

function SavePlaylistButton({
  artists,
  prompt,
  state,
  onSave,
}: {
  artists: string[];
  prompt: string;
  state: "idle" | "saving" | "done" | "error";
  onSave: () => void;
}) {
  if (state === "done") {
    return (
      <button
        onClick={onSave}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 text-xs font-medium hover:bg-emerald-100 transition-colors"
        title="Create another playlist"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 5v14M5 12h14" strokeLinecap="round" />
        </svg>
        Save New Playlist
      </button>
    );
  }

  return (
    <button
      onClick={onSave}
      disabled={state === "saving" || artists.length === 0}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#1DB954] text-white text-xs font-medium hover:bg-[#1aa34a] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      title={`Save ${artists.length} artists as a Spotify playlist`}
    >
      {state === "saving" ? (
        <>
          <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <circle cx="12" cy="12" r="10" strokeOpacity="0.3" />
            <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
          </svg>
          Creating playlist…
        </>
      ) : (
        <>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
          </svg>
          Save as Playlist
        </>
      )}
    </button>
  );
}
