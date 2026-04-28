"use client";

import { useCallback, useEffect, useState } from "react";
import { usePlayer } from "./player-context";

type Track = {
  name: string;
  artist: string;
  album: string;
  album_art: string | null;
  duration_ms: number;
  spotify_url: string;
  uri: string;
};

type Playlist = {
  id: string;
  name: string;
  description: string;
  spotify_url: string;
  image: string | null;
  track_count: number;
  tracks: Track[];
};

export default function PlaylistsView() {
  const [playlists, setPlaylists] = useState<Playlist[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPlaylists = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/playlists");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Failed to load playlists");
        setPlaylists([]);
        return;
      }
      setPlaylists(data.playlists ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setPlaylists([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPlaylists();
  }, [fetchPlaylists]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="flex items-center gap-2 text-sm text-neutral-400">
          <svg
            className="animate-spin"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          >
            <circle cx="12" cy="12" r="10" strokeOpacity="0.3" />
            <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
          </svg>
          Loading playlists…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="border border-red-200 bg-red-50 text-red-700 rounded-lg p-3 text-sm">
        {error}
      </div>
    );
  }

  if (!playlists || playlists.length === 0) {
    return <EmptyPlaylists />;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-neutral-400">
          {playlists.length} playlist{playlists.length !== 1 ? "s" : ""}
        </p>
        <button
          onClick={fetchPlaylists}
          className="text-[11px] text-neutral-400 hover:text-neutral-600 transition-colors"
        >
          ↻ Refresh
        </button>
      </div>

      <div className="space-y-2">
        {playlists.map((pl) => (
          <PlaylistCard key={pl.id} playlist={pl} />
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/*  Playlist card with expandable track list                      */
/* ═══════════════════════════════════════════════════════════════ */

function PlaylistCard({ playlist }: { playlist: Playlist }) {
  const [expanded, setExpanded] = useState(false);
  const [favoritedIds, setFavoritedIds] = useState<Set<string>>(new Set());

  // Fetch favorites when tracks are expanded
  useEffect(() => {
    if (!expanded || playlist.tracks.length === 0) return;
    const trackIds = playlist.tracks
      .map((t) => t.uri?.startsWith("spotify:track:") ? t.uri.replace("spotify:track:", "") : null)
      .filter(Boolean) as string[];
    if (trackIds.length === 0) return;
    fetch(`/api/favorites-check?ids=${trackIds.join(",")}`)
      .then((r) => r.json())
      .then((d) => setFavoritedIds(new Set(d.favorited ?? [])))
      .catch(() => {});
  }, [expanded, playlist.tracks]);

  return (
    <div className="border border-neutral-200 rounded-lg overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-neutral-50 transition-colors text-left"
      >
        {/* Playlist art */}
        <div className="shrink-0 w-12 h-12 rounded-md bg-neutral-100 overflow-hidden flex items-center justify-center">
          {playlist.image ? (
            <img
              src={playlist.image}
              alt={playlist.name}
              className="w-full h-full object-cover"
            />
          ) : (
            <span className="text-xl">🎶</span>
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-neutral-900 truncate">
            {playlist.name}
          </p>
          <p className="text-[11px] text-neutral-400 truncate mt-0.5">
            {playlist.track_count} track{playlist.track_count !== 1 ? "s" : ""}
            {playlist.description && ` · ${playlist.description}`}
          </p>
        </div>

        {/* Spotify link */}
        <a
          href={playlist.spotify_url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          title="Open in Spotify"
          className="shrink-0 text-neutral-300 hover:text-[#1DB954] transition-colors"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
          </svg>
        </a>

        {/* Expand chevron */}
        <span
          className={`shrink-0 text-neutral-300 transition-transform duration-200 ${
            expanded ? "rotate-180" : ""
          }`}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>

      {/* Expanded track list */}
      {expanded && (
        <div className="border-t border-neutral-100">
          {playlist.tracks.length === 0 ? (
            <p className="px-4 py-3 text-xs text-neutral-400 italic">
              No tracks loaded
            </p>
          ) : (
            <div className="divide-y divide-neutral-50">
              {playlist.tracks.map((track, i) => (
                <TrackRow
                  key={`${track.uri}-${i}`}
                  track={track}
                  index={i + 1}
                  initialFavorited={favoritedIds.has(
                    track.uri?.startsWith("spotify:track:") ? track.uri.replace("spotify:track:", "") : ""
                  )}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/*  Track row                                                     */
/* ═══════════════════════════════════════════════════════════════ */

function TrackRow({ track, index, initialFavorited = false }: { track: Track; index: number; initialFavorited?: boolean }) {
  const { playArtist, playTrack } = usePlayer();
  const [playing, setPlaying] = useState(false);
  const [favorited, setFavorited] = useState(initialFavorited);
  const [favLoading, setFavLoading] = useState(false);

  // Extract spotify track ID from URI (spotify:track:XXXX → XXXX)
  const spotifyTrackId = track.uri?.startsWith("spotify:track:")
    ? track.uri.replace("spotify:track:", "")
    : null;

  const minutes = Math.floor(track.duration_ms / 60000);
  const seconds = Math.floor((track.duration_ms % 60000) / 1000);
  const duration = `${minutes}:${seconds.toString().padStart(2, "0")}`;

  async function handlePlay() {
    setPlaying(true);
    if (spotifyTrackId) {
      await playTrack(spotifyTrackId);
    } else {
      await playArtist(track.artist.split(",")[0].trim());
    }
    setPlaying(false);
  }

  async function handleFavorite() {
    if (favLoading || !spotifyTrackId) return;
    setFavLoading(true);
    try {
      const method = favorited ? "DELETE" : "POST";
      const res = await fetch("/api/favorite", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          spotify_track_id: spotifyTrackId,
          track_name: track.name,
          artist_name: track.artist,
          source: "playlists",
        }),
      });
      if (res.ok) setFavorited(!favorited);
    } catch {}
    setFavLoading(false);
  }

  return (
    <div className="flex items-center gap-3 px-4 py-2 hover:bg-neutral-50/80 transition-colors group">
      {/* Track number */}
      <span className="w-5 text-right text-[11px] tabular-nums text-neutral-300 shrink-0">
        {index}
      </span>

      {/* Album art */}
      <div className="shrink-0 w-9 h-9 rounded bg-neutral-100 overflow-hidden">
        {track.album_art ? (
          <img
            src={track.album_art}
            alt={track.album}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-neutral-300 text-xs">
            ♪
          </div>
        )}
      </div>

      {/* Song info */}
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-medium text-neutral-800 truncate">
          {track.name}
        </p>
        <p className="text-[11px] text-neutral-400 truncate">
          {track.artist}
          {track.album && <span className="text-neutral-300"> · {track.album}</span>}
        </p>
      </div>

      {/* Duration */}
      <span className="text-[11px] tabular-nums text-neutral-300 shrink-0">
        {duration}
      </span>

      {/* Play button — always visible on touch, hover-revealed on desktop */}
      <button
        onClick={handlePlay}
        disabled={playing}
        aria-label={`Play ${track.name}`}
        className="shrink-0 w-8 h-8 sm:w-7 sm:h-7 rounded-full flex items-center justify-center bg-neutral-900 text-white opacity-100 sm:opacity-0 sm:group-hover:opacity-100 hover:bg-neutral-700 active:scale-95 transition-all disabled:opacity-40"
        title={`Play ${track.name}`}
      >
        {playing ? (
          <svg
            className="animate-spin"
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          >
            <circle cx="12" cy="12" r="10" strokeOpacity="0.3" />
            <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
          </svg>
        ) : (
          <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>

      {/* Favorite heart — always visible on touch, hover on desktop */}
      <button
        onClick={handleFavorite}
        disabled={favLoading || !spotifyTrackId}
        title={favorited ? "Remove from Liked Songs" : "Save to Liked Songs"}
        className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center transition-all active:scale-90 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 disabled:opacity-30 ${
          favorited
            ? "text-rose-500 hover:text-rose-400"
            : "text-neutral-300 hover:text-rose-500"
        }`}
      >
        {favorited ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>

      {/* Spotify link — desktop hover only */}
      {track.spotify_url && (
        <a
          href={track.spotify_url}
          target="_blank"
          rel="noopener noreferrer"
          className="hidden sm:inline-flex shrink-0 text-neutral-200 hover:text-[#1DB954] transition-colors opacity-0 group-hover:opacity-100"
          title="Open in Spotify"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
          </svg>
        </a>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/*  Empty state                                                   */
/* ═══════════════════════════════════════════════════════════════ */

function EmptyPlaylists() {
  return (
    <div className="border border-dashed border-neutral-200 rounded-xl p-12 text-center space-y-3">
      <div className="text-4xl">📀</div>
      <div>
        <p className="text-sm font-medium text-neutral-700">No playlists yet</p>
        <p className="text-xs text-neutral-400 mt-1 max-w-xs mx-auto leading-relaxed">
          Go to <strong>Discover</strong>, get some recommendations, and hit{" "}
          <strong>Save as Playlist</strong> to create your first one.
        </p>
      </div>
    </div>
  );
}
