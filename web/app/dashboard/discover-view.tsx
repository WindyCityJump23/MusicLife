"use client";

import { useState } from "react";
import { usePlayer } from "./player-context";

type SignalBreakdown = {
  affinity: number;
  context: number;
  editorial: number;
  track_popularity?: number;
  audio_match?: number;
};
type TopMention = { source: string; excerpt: string; published_at: string };

type SongRecommendation = {
  track_id: string | null;
  track_name: string;
  artist_id: string;
  artist_name: string;
  album_name: string;
  duration_ms: number;
  explicit: boolean;
  spotify_track_id: string;
  score: number;
  signals: SignalBreakdown;
  reasons: string[];
  genres: string[];
  mention_count: number;
  top_mention: TopMention | null;
};

export default function DiscoverView({
  onNavigate,
}: {
  onNavigate?: (view: string) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [weights, setWeights] = useState({
    affinity: 40,
    context: 40,
    editorial: 20,
  });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [results, setResults] = useState<SongRecommendation[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playlistState, setPlaylistState] = useState<
    "idle" | "saving" | "done" | "error"
  >("idle");
  const [playlistUrl, setPlaylistUrl] = useState<string | null>(null);
  const [playlistError, setPlaylistError] = useState<string | null>(null);
  const [playlistStats, setPlaylistStats] = useState<{
    added: number;
    failed: string[];
  } | null>(null);

  async function handleSubmit() {
    setLoading(true);
    setError(null);
    setPlaylistState("idle");
    setPlaylistUrl(null);
    setPlaylistError(null);
    setPlaylistStats(null);
    try {
      const normalized = {
        affinity: weights.affinity / 100,
        context: weights.context / 100,
        editorial: weights.editorial / 100,
      };
      const res = await fetch(`/api/recommend-songs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: prompt || null,
          weights: normalized,
          limit: 30,
          exclude_library: false,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          data.error ?? data.detail ?? "Failed to get recommendations"
        );
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

  async function handleSavePlaylist() {
    if (!results || results.length === 0) return;
    setPlaylistState("saving");
    setPlaylistError(null);
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
        ? `MusicLife: ${prompt.slice(0, 40)}${prompt.length > 40 ? "\u2026" : ""}`
        : `MusicLife Discover \u2014 ${dateStr}`;
      const description = prompt
        ? `"${prompt}" \u2014 Personalized by MusicLife on ${dateStr}`
        : `Personalized discovery playlist by MusicLife \u2014 ${dateStr}`;

      // Collect Spotify track IDs directly — no re-searching needed
      const trackIds = results
        .map((r) => r.spotify_track_id)
        .filter(Boolean);

      const res = await fetch("/api/playlist-from-tracks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ track_ids: trackIds, name, description }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPlaylistState("error");
        setPlaylistError(data.error ?? "Failed to create playlist");
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
  }

  return (
    <div className="max-w-2xl space-y-5">
      {/* Search */}
      <div className="space-y-2">
        <div className="flex gap-2">
          <input
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            placeholder="What are you in the mood for? (e.g. chill lo-fi, energetic hip-hop, 90s rock\u2026)"
            className="flex-1 px-4 py-2.5 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 placeholder:text-neutral-400"
          />
          <button
            onClick={handleSubmit}
            disabled={loading}
            className="px-5 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
          >
            {loading ? "Finding\u2026" : "Discover"}
          </button>
        </div>

        {/* Advanced toggle */}
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="text-[11px] text-neutral-400 hover:text-neutral-600"
        >
          {showAdvanced ? "\u25be Hide tuning" : "\u25b8 Tune weights"}
        </button>
        {showAdvanced && (
          <div className="space-y-3 pt-1 pb-2">
            <div className="grid grid-cols-3 gap-4">
              <WeightSlider
                label="Taste"
                hint="How close to your listening DNA"
                value={weights.affinity}
                onChange={(v) => setWeights({ ...weights, affinity: v })}
              />
              <WeightSlider
                label="Mood"
                hint="Vibe match from editorial context"
                value={weights.context}
                onChange={(v) => setWeights({ ...weights, context: v })}
              />
              <WeightSlider
                label="Buzz"
                hint="Currently talked about in press"
                value={weights.editorial}
                onChange={(v) => setWeights({ ...weights, editorial: v })}
              />
            </div>
            <p className="text-[10px] text-neutral-400 leading-relaxed">
              \ud83c\udfb2 Results shuffle each time you hit Discover. Songs you&apos;ve
              already saved are ranked lower.
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
              {results.length} song{results.length !== 1 ? "s" : ""} recommended
            </p>
            <SavePlaylistButton
              state={playlistState}
              count={results.length}
              onSave={handleSavePlaylist}
            />
          </div>

          {/* Playlist success banner */}
          {playlistState === "done" && playlistUrl && (
            <div className="border border-emerald-200 bg-emerald-50 rounded-lg p-3 flex items-center gap-3">
              <span className="text-lg">\ud83c\udf89</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-emerald-800">
                  Playlist created!
                  {playlistStats && (
                    <span className="font-normal text-emerald-600">
                      {" "}
                      \u2014 {playlistStats.added} track
                      {playlistStats.added !== 1 ? "s" : ""} added
                      {playlistStats.failed.length > 0 && (
                        <>, {playlistStats.failed.length} skipped</>
                      )}
                    </span>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {onNavigate && (
                  <button
                    onClick={() => onNavigate("playlists")}
                    className="px-3 py-1.5 rounded-lg border border-emerald-200 text-emerald-700 text-xs font-medium hover:bg-emerald-100 transition-colors"
                  >
                    View in Playlists \u2192
                  </button>
                )}
                <a
                  href={playlistUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-1.5 rounded-lg bg-[#1DB954] text-white text-xs font-medium hover:bg-[#1aa34a] transition-colors flex items-center gap-1.5"
                >
                  <SpotifyIcon size={14} />
                  Open in Spotify
                </a>
              </div>
            </div>
          )}

          {/* Playlist error banner */}
          {playlistState === "error" && playlistError && (
            <div className="border border-red-200 bg-red-50 rounded-lg p-3 flex items-center gap-2">
              <span className="text-sm">\u26a0\ufe0f</span>
              <p className="text-sm text-red-700 flex-1">{playlistError}</p>
              <button
                onClick={() => {
                  setPlaylistState("idle");
                  setPlaylistError(null);
                }}
                className="text-xs text-red-400 hover:text-red-600"
              >
                \u2715
              </button>
            </div>
          )}

          {/* Song list */}
          <div className="border border-neutral-200 rounded-lg overflow-hidden divide-y divide-neutral-100">
            {results.map((song, i) => (
              <SongRow key={`${song.spotify_track_id}-${i}`} song={song} rank={i + 1} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
/*  Song Row                                                      */
/* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */

function SongRow({
  song,
  rank,
}: {
  song: SongRecommendation;
  rank: number;
}) {
  const { playTrack, playArtist } = usePlayer();
  const [playState, setPlayState] = useState<"idle" | "loading">("idle");
  const [favorited, setFavorited] = useState(false);
  const [favLoading, setFavLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const matchPct = Math.round(song.score * 100);
  const minutes = Math.floor(song.duration_ms / 60000);
  const seconds = Math.floor((song.duration_ms % 60000) / 1000);
  const duration =
    song.duration_ms > 0
      ? `${minutes}:${seconds.toString().padStart(2, "0")}`
      : "";

  const spotifyTrackUrl = song.spotify_track_id
    ? `https://open.spotify.com/track/${song.spotify_track_id}`
    : `https://open.spotify.com/search/${encodeURIComponent(
        `${song.track_name} ${song.artist_name}`
      )}`;

  async function handlePlay() {
    setPlayState("loading");
    let result: { ok: boolean; error?: string };

    // Play the exact song if we have a Spotify track ID
    if (song.spotify_track_id) {
      result = await playTrack(song.spotify_track_id);
    } else {
      // Fallback: play artist's top tracks
      result = await playArtist(song.artist_name);
    }

    setPlayState("idle");
    if (!result.ok) {
      window.open(spotifyTrackUrl, "_blank", "noopener");
    }
  }

  return (
    <div className="group">
      <div className="flex items-center gap-3 px-3 py-2.5 hover:bg-neutral-50 transition-colors">
        {/* Rank */}
        <span className="w-6 text-right text-xs tabular-nums text-neutral-300 font-medium shrink-0">
          {rank}
        </span>

        {/* Song info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-neutral-900 truncate">
              {song.track_name}
            </span>
            {song.explicit && (
              <span className="shrink-0 text-[9px] font-bold bg-neutral-200 text-neutral-500 rounded px-1 py-0.5 leading-none">
                E
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <p className="text-[11px] text-neutral-500 truncate">
              {song.artist_name}
            </p>
            {song.album_name && (
              <>
                <span className="text-neutral-300 text-[10px]">\u00b7</span>
                <p className="text-[11px] text-neutral-400 truncate">
                  {song.album_name}
                </p>
              </>
            )}
          </div>
          {/* Reason line */}
          {song.reasons.length > 0 && (
            <p className="text-[10px] text-neutral-400 truncate mt-0.5">
              {song.reasons[0]}
            </p>
          )}
        </div>

        {/* Duration */}
        {duration && (
          <span className="shrink-0 text-[11px] tabular-nums text-neutral-300 hidden sm:block">
            {duration}
          </span>
        )}

        {/* Match score badge */}
        <div
          className="shrink-0 w-10 h-10 rounded-full flex items-center justify-center text-xs font-bold"
          style={{
            background:
              matchPct > 70
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
          title={`Play ${song.track_name}`}
          className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center bg-neutral-900 text-white hover:bg-neutral-700 active:scale-95 transition-all disabled:opacity-40"
        >
          {playState === "loading" ? (
            <svg
              className="animate-spin"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <circle cx="12" cy="12" r="10" strokeOpacity="0.3" />
              <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
            </svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

        {/* Favorite (heart) button */}
        <button
          onClick={async () => {
            if (favLoading || !song.spotify_track_id) return;
            setFavLoading(true);
            try {
              const method = favorited ? "DELETE" : "POST";
              const res = await fetch("/api/favorite", {
                method,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  spotify_track_id: song.spotify_track_id,
                  track_name: song.track_name,
                  artist_name: song.artist_name,
                  score: song.score,
                  source: "discover",
                }),
              });
              if (res.ok) setFavorited(!favorited);
            } catch {}
            setFavLoading(false);
          }}
          disabled={favLoading || !song.spotify_track_id}
          title={favorited ? "Remove from Liked Songs" : "Save to Liked Songs"}
          className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center transition-all active:scale-90 disabled:opacity-30 ${
            favorited
              ? "text-rose-500 hover:text-rose-400"
              : "text-neutral-300 hover:text-rose-500"
          }`}
        >
          {favorited ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>

        {/* Spotify link */}
        <a
          href={spotifyTrackUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="Open in Spotify"
          className="shrink-0 text-neutral-300 hover:text-[#1DB954] transition-colors"
        >
          <SpotifyIcon size={16} />
        </a>

        {/* Expand toggle */}
        {(song.top_mention || song.reasons.length > 1 || song.genres.length > 0) && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="shrink-0 text-neutral-300 hover:text-neutral-500 transition-colors text-xs"
            title="More info"
          >
            {expanded ? "\u25be" : "\u25b8"}
          </button>
        )}
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="px-3 pb-3 pl-12 space-y-2">
          {/* Signal breakdown */}
          <div className="flex gap-3 text-[10px] flex-wrap">
            <SignalPill label="Taste" value={song.signals.affinity} color="emerald" />
            <SignalPill label="Mood" value={song.signals.context} color="blue" />
            <SignalPill label="Buzz" value={song.signals.editorial} color="amber" />
            {song.signals.track_popularity !== undefined && (
              <SignalPill label="Popularity" value={song.signals.track_popularity} color="purple" />
            )}
            {(song.signals.audio_match ?? 0) > 0 && (
              <SignalPill label="Sound" value={song.signals.audio_match!} color="rose" />
            )}
          </div>

          {/* All reasons */}
          {song.reasons.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {song.reasons.map((r, i) => (
                <span
                  key={i}
                  className="text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-full px-2 py-0.5"
                >
                  {r}
                </span>
              ))}
              {song.mention_count > 0 && (
                <span className="text-[10px] text-neutral-500 bg-neutral-50 border border-neutral-100 rounded-full px-2 py-0.5">
                  {song.mention_count} mention{song.mention_count !== 1 ? "s" : ""}
                </span>
              )}
            </div>
          )}

          {/* Editorial excerpt */}
          {song.top_mention?.excerpt && (
            <div className="bg-neutral-50 border border-neutral-100 rounded-md px-3 py-2">
              <p className="text-[11px] text-neutral-600 leading-relaxed line-clamp-2 italic">
                &ldquo;{song.top_mention.excerpt}&rdquo;
              </p>
              {song.top_mention.source && (
                <p className="text-[10px] text-neutral-400 mt-1">
                  \u2014 {song.top_mention.source}
                </p>
              )}
            </div>
          )}

          {/* Genre pills */}
          {song.genres.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {song.genres.slice(0, 5).map((g) => (
                <span
                  key={g}
                  className="text-[10px] text-neutral-500 bg-neutral-100 rounded-full px-2 py-0.5 capitalize"
                >
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

/* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
/*  Small components                                              */
/* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */

function SignalPill({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  const pct = Math.round(value * 100);
  const colorMap: Record<string, string> = {
    emerald: "text-emerald-700 bg-emerald-50 border-emerald-100",
    blue: "text-blue-700 bg-blue-50 border-blue-100",
    amber: "text-amber-700 bg-amber-50 border-amber-100",
    purple: "text-purple-700 bg-purple-50 border-purple-100",
    rose: "text-rose-700 bg-rose-50 border-rose-100",
  };
  return (
    <span
      className={`border rounded-full px-2 py-0.5 tabular-nums ${
        colorMap[color] ?? colorMap.emerald
      }`}
    >
      {label} {pct}%
    </span>
  );
}

function WeightSlider({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <div className="flex items-center justify-between text-xs text-neutral-600 mb-1">
        <span className="font-medium" title={hint}>
          {label}
        </span>
        <span className="tabular-nums text-neutral-400">{value}%</span>
      </div>
      {hint && (
        <p className="text-[9px] text-neutral-400 mb-1.5 leading-tight">
          {hint}
        </p>
      )}
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

function SpotifyIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
    </svg>
  );
}

function SavePlaylistButton({
  state,
  count,
  onSave,
}: {
  state: "idle" | "saving" | "done" | "error";
  count: number;
  onSave: () => void;
}) {
  if (state === "done") {
    return (
      <button
        onClick={onSave}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 text-xs font-medium hover:bg-emerald-100 transition-colors"
        title="Create another playlist"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M12 5v14M5 12h14" strokeLinecap="round" />
        </svg>
        Save New Playlist
      </button>
    );
  }

  return (
    <button
      onClick={onSave}
      disabled={state === "saving" || count === 0}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#1DB954] text-white text-xs font-medium hover:bg-[#1aa34a] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      title={`Save ${count} songs as a Spotify playlist`}
    >
      {state === "saving" ? (
        <>
          <svg
            className="animate-spin"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          >
            <circle cx="12" cy="12" r="10" strokeOpacity="0.3" />
            <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
          </svg>
          Creating playlist\u2026
        </>
      ) : (
        <>
          <SpotifyIcon size={14} />
          Save as Playlist
        </>
      )}
    </button>
  );
}

function EmptyInitial() {
  return (
    <div className="border border-dashed border-neutral-200 rounded-xl p-12 text-center space-y-3">
      <div className="text-4xl">\ud83c\udfa7</div>
      <div>
        <p className="text-sm font-medium text-neutral-700">
          Discover new songs
        </p>
        <p className="text-xs text-neutral-400 mt-1 max-w-xs mx-auto leading-relaxed">
          Describe what you&apos;re in the mood for, or just hit{" "}
          <strong>Discover</strong> to get personalized song recommendations
          based on your taste profile.
        </p>
      </div>
    </div>
  );
}

function EmptyNoResults() {
  return (
    <div className="border border-dashed border-neutral-200 rounded-xl p-12 text-center space-y-3">
      <div className="text-4xl">\ud83c\udfbb</div>
      <div>
        <p className="text-sm font-medium text-neutral-700">No songs found</p>
        <p className="text-xs text-neutral-400 mt-1 max-w-xs mx-auto">
          Make sure you&apos;ve synced, enriched, and embedded your library
          first.
        </p>
      </div>
    </div>
  );
}
