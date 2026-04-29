"use client";

import { useEffect, useRef } from "react";
import { usePlayer } from "./player-context";

/**
 * Spotify Embed Player with queue controls and auto-advance.
 *
 * Uses Spotify's IFrame API for:
 * - Programmatic play/pause/loadUri control
 * - playback_update events to detect track end → auto-advance
 *
 * The controller is created once on mount. Track changes use loadUri()
 * which triggers playback more reliably than creating a new controller
 * each time (avoids losing the user-gesture context).
 */
export default function Player() {
  const {
    queue,
    currentIndex,
    embedTrackId,
    playNext,
    playPrev,
    playFromQueue,
  } = usePlayer();

  const currentTrack = currentIndex >= 0 && currentIndex < queue.length
    ? queue[currentIndex]
    : null;

  const hasNext = currentIndex < queue.length - 1;
  const hasPrev = currentIndex > 0;

  // Refs for IFrame API
  const controllerRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const apiReadyRef = useRef(false);
  const playNextRef = useRef(playNext);
  const pendingTrackRef = useRef<string | null>(null);
  playNextRef.current = playNext;

  // ── Load Spotify IFrame API once ─────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;

    function onApiReady(IFrameAPI: any) {
      apiReadyRef.current = true;

      // Create controller immediately (with current track or placeholder)
      const container = containerRef.current;
      if (!container) return;

      const trackId = pendingTrackRef.current || "4cOdK2wGLETKBW3PvgPWqT"; // placeholder
      const uri = `spotify:track:${trackId}`;

      IFrameAPI.createController(
        container,
        {
          uri,
          width: "100%",
          height: 152,
          theme: "0",
        },
        (ctrl: any) => {
          controllerRef.current = ctrl;

          // Auto-advance listener
          ctrl.addListener("playback_update", (e: any) => {
            const data = e?.data;
            if (!data) return;
            const { isPaused, isBuffering, duration, position } = data;

            if (
              isPaused &&
              !isBuffering &&
              duration > 0 &&
              position > 0 &&
              duration - position < 2000
            ) {
              setTimeout(() => playNextRef.current(), 600);
            }
          });

          // If we had a pending track, play it now
          if (pendingTrackRef.current) {
            ctrl.loadUri(`spotify:track:${pendingTrackRef.current}`);
            ctrl.play();
            pendingTrackRef.current = null;
          }
        }
      );
    }

    // Check if API is already loaded
    if ((window as any).SpotifyIframeApi) {
      onApiReady((window as any).SpotifyIframeApi);
    } else {
      (window as any).onSpotifyIframeApiReady = (IFrameAPI: any) => {
        (window as any).SpotifyIframeApi = IFrameAPI;
        onApiReady(IFrameAPI);
      };

      if (!document.querySelector('script[src*="embed/iframe-api"]')) {
        const script = document.createElement("script");
        script.src = "https://open.spotify.com/embed/iframe-api/v1";
        script.async = true;
        document.body.appendChild(script);
      }
    }

    return () => {
      (window as any).onSpotifyIframeApiReady = undefined;
    };
  }, []);

  // ── When embedTrackId changes, load it into the existing controller ──
  useEffect(() => {
    if (!embedTrackId) return;

    if (controllerRef.current) {
      controllerRef.current.loadUri(`spotify:track:${embedTrackId}`);
      // play() after loadUri — works because controller already exists
      // and user has previously interacted with the page
      setTimeout(() => controllerRef.current?.play(), 300);
    } else {
      // Controller not ready yet — store pending track
      pendingTrackRef.current = embedTrackId;
    }
  }, [embedTrackId]);

  // ── Render ───────────────────────────────────────────────────
  return (
    <div
      className="rounded-2xl flex flex-col gap-4 p-5 min-h-full"
      style={{ background: "linear-gradient(160deg, #1a1a2e 0%, #16213e 60%, #0f3460 100%)" }}
    >
      {/* Header */}
      <div className="text-center">
        <p className="text-[10px] font-bold tracking-[0.25em] uppercase" style={{ color: "#e94560" }}>
          ♫ Now Playing
        </p>
      </div>

      {/* Current track info */}
      {currentTrack ? (
        <div className="text-center px-2">
          <p className="text-white font-semibold text-sm leading-snug truncate">
            {currentTrack.trackName}
          </p>
          <p className="text-xs mt-0.5 truncate" style={{ color: "rgba(255,255,255,0.55)" }}>
            {currentTrack.artistName}
          </p>
        </div>
      ) : (
        <div className="text-center px-2">
          <p className="text-white font-medium text-sm">Pick a song</p>
          <p className="text-xs mt-0.5" style={{ color: "rgba(255,255,255,0.4)" }}>
            Click play on any recommendation to start
          </p>
        </div>
      )}

      {/* Spotify Embed container — always mounted so controller persists */}
      <div
        ref={containerRef}
        className="rounded-xl overflow-hidden"
        style={{ minHeight: 152 }}
      />

      {/* Queue controls */}
      {queue.length > 1 && (
        <div className="flex items-center justify-center gap-4">
          <button
            onClick={playPrev}
            disabled={!hasPrev}
            aria-label="Previous track"
            className="w-10 h-10 rounded-full flex items-center justify-center transition-all disabled:opacity-25 active:scale-95"
            style={{
              background: "rgba(255,255,255,0.07)",
              border: "1px solid rgba(255,255,255,0.12)",
              color: "rgba(255,255,255,0.8)",
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />
            </svg>
          </button>

          <span className="text-[11px] tabular-nums" style={{ color: "rgba(255,255,255,0.4)" }}>
            {currentIndex + 1} / {queue.length}
          </span>

          <button
            onClick={playNext}
            disabled={!hasNext}
            aria-label="Next track"
            className="w-10 h-10 rounded-full flex items-center justify-center transition-all disabled:opacity-25 active:scale-95"
            style={{
              background: "rgba(255,255,255,0.07)",
              border: "1px solid rgba(255,255,255,0.12)",
              color: "rgba(255,255,255,0.8)",
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 18l8.5-6L6 6v12zm2.5-6 5.5 3.9V8.1L8.5 12zM16 6h2v12h-2z" />
            </svg>
          </button>
        </div>
      )}

      {/* Up Next preview */}
      {hasNext && queue[currentIndex + 1] && (
        <div
          className="rounded-lg px-3 py-2 cursor-pointer hover:opacity-80 transition-opacity"
          style={{ background: "rgba(255,255,255,0.05)" }}
          onClick={() => playFromQueue(currentIndex + 1)}
        >
          <p className="text-[10px] uppercase tracking-wider mb-0.5" style={{ color: "rgba(255,255,255,0.3)" }}>
            Up Next
          </p>
          <p className="text-xs text-white truncate">{queue[currentIndex + 1].trackName}</p>
          <p className="text-[11px] truncate" style={{ color: "rgba(255,255,255,0.45)" }}>
            {queue[currentIndex + 1].artistName}
          </p>
        </div>
      )}

      {/* Queue list */}
      {queue.length > 2 && (
        <div className="space-y-1">
          <p className="text-[10px] uppercase tracking-wider px-1" style={{ color: "rgba(255,255,255,0.3)" }}>
            Queue ({queue.length} songs)
          </p>
          <div className="max-h-48 overflow-y-auto space-y-0.5 rounded-lg" style={{ background: "rgba(0,0,0,0.2)" }}>
            {queue.map((t, i) => (
              <button
                key={`${t.spotifyTrackId}-${i}`}
                onClick={() => playFromQueue(i)}
                className={[
                  "w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2",
                  i === currentIndex
                    ? "bg-white/10 text-white"
                    : "text-white/50 hover:bg-white/5 hover:text-white/70",
                ].join(" ")}
              >
                <span className="w-5 text-right tabular-nums text-[10px] shrink-0" style={{ color: i === currentIndex ? "#e94560" : undefined }}>
                  {i === currentIndex ? "▶" : i + 1}
                </span>
                <span className="truncate">{t.trackName}</span>
                <span className="ml-auto shrink-0 text-[10px]" style={{ color: "rgba(255,255,255,0.3)" }}>
                  {t.artistName}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
