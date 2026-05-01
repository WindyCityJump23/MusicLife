"use client";

import { Component, useEffect, useRef, type ReactNode } from "react";
import { usePlayer } from "./player-context";

class PlayerErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div
          className="rounded-2xl flex flex-col items-center justify-center gap-3 p-5 min-h-full"
          style={{
            background:
              "linear-gradient(160deg, #1a1a2e 0%, #16213e 60%, #0f3460 100%)",
          }}
        >
          <p className="text-white/60 text-sm text-center">
            Player unavailable. Open Spotify on your device to listen.
          </p>
          <button
            type="button"
            className="text-xs text-white/40 underline"
            onClick={() => this.setState({ hasError: false })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Player panel.
 *
 * Two modes:
 *  - "connect" — remote-control a Spotify Connect device (phone, desktop app,
 *    speaker). Audio plays on that device, so it survives screen lock and
 *    backgrounding. This is the primary path.
 *  - "embed"   — Spotify iframe in this page. Used as a fallback when no
 *    Connect device is online (and for free-tier 30s previews).
 *
 * The Player auto-selects connect mode when a device is detected, defaulting
 * to the user's phone if available so the gym scenario "just works".
 */
export default function Player() {
  const {
    queue,
    currentIndex,
    embedTrackId,
    mode,
    setMode,
    devices,
    selectedDeviceId,
    selectDevice,
    refreshDevices,
    devicesLoading,
    playNext,
    playPrev,
    playFromQueue,
    togglePause,
    isPlaying,
    playbackError,
    clearPlaybackError,
  } = usePlayer();

  const currentTrack =
    currentIndex >= 0 && currentIndex < queue.length ? queue[currentIndex] : null;

  const hasNext = currentIndex < queue.length - 1;
  const hasPrev = currentIndex > 0;

  const usableDevices = devices.filter((d) => !d.is_restricted);
  const selectedDevice =
    usableDevices.find((d) => d.id === selectedDeviceId) ?? null;

  return (
    <PlayerErrorBoundary>
    <div
      className="rounded-2xl flex flex-col gap-4 p-5 min-h-full"
      style={{
        background:
          "linear-gradient(160deg, #1a1a2e 0%, #16213e 60%, #0f3460 100%)",
      }}
    >
      {/* Header */}
      <div className="text-center">
        <p
          className="text-[10px] font-bold tracking-[0.25em] uppercase"
          style={{ color: "#e94560" }}
        >
          ♫ Now Playing
        </p>
      </div>

      {/* Current track info */}
      {currentTrack ? (
        <div className="text-center px-2">
          <p className="text-white font-semibold text-sm leading-snug truncate">
            {currentTrack.trackName}
          </p>
          <p
            className="text-xs mt-0.5 truncate"
            style={{ color: "rgba(255,255,255,0.55)" }}
          >
            {currentTrack.artistName}
          </p>
        </div>
      ) : (
        <div className="text-center px-2">
          <p className="text-white font-medium text-sm">Pick a song</p>
          <p
            className="text-xs mt-0.5"
            style={{ color: "rgba(255,255,255,0.4)" }}
          >
            Click play on any recommendation to start
          </p>
        </div>
      )}

      {/* Device picker */}
      <DevicePicker
        devices={usableDevices}
        selectedDeviceId={selectedDeviceId}
        selectedDevice={selectedDevice}
        mode={mode}
        loading={devicesLoading}
        onSelect={(id) => {
          if (id === "__embed__") {
            setMode("embed");
            selectDevice(null);
          } else {
            selectDevice(id);
          }
        }}
        onRefresh={refreshDevices}
      />

      {/* Error banner */}
      {playbackError && (
        <div className="rounded-lg px-3 py-2 text-xs flex items-start gap-2"
          style={{
            background: "rgba(233, 69, 96, 0.12)",
            border: "1px solid rgba(233, 69, 96, 0.4)",
            color: "rgba(255, 220, 220, 0.95)",
          }}
        >
          <span className="flex-1">{playbackError}</span>
          <button
            type="button"
            onClick={clearPlaybackError}
            aria-label="Dismiss error"
            className="opacity-60 hover:opacity-100"
          >
            ×
          </button>
        </div>
      )}

      {/* Mode-specific player */}
      {mode === "connect" && selectedDeviceId ? (
        <ConnectControls
          isPlaying={isPlaying}
          hasNext={hasNext}
          hasPrev={hasPrev}
          onPrev={playPrev}
          onNext={playNext}
          onTogglePause={togglePause}
          deviceName={selectedDevice?.name ?? "device"}
        />
      ) : (
        <EmbedPlayer trackId={embedTrackId} onTrackEnd={playNext} />
      )}

      {/* Queue position + queue list (works in both modes) */}
      {queue.length > 1 && (
        <div className="flex items-center justify-center gap-2">
          <span
            className="text-[11px] tabular-nums"
            style={{ color: "rgba(255,255,255,0.4)" }}
          >
            {currentIndex >= 0 ? currentIndex + 1 : 0} / {queue.length}
          </span>
        </div>
      )}

      {/* Up Next preview */}
      {hasNext && queue[currentIndex + 1] && (
        <div
          className="rounded-lg px-3 py-2 cursor-pointer hover:opacity-80 transition-opacity"
          style={{ background: "rgba(255,255,255,0.05)" }}
          onClick={() => playFromQueue(currentIndex + 1)}
        >
          <p
            className="text-[10px] uppercase tracking-wider mb-0.5"
            style={{ color: "rgba(255,255,255,0.3)" }}
          >
            Up Next
          </p>
          <p className="text-xs text-white truncate">
            {queue[currentIndex + 1].trackName}
          </p>
          <p
            className="text-[11px] truncate"
            style={{ color: "rgba(255,255,255,0.45)" }}
          >
            {queue[currentIndex + 1].artistName}
          </p>
        </div>
      )}

      {/* Queue list */}
      {queue.length > 2 && (
        <div className="space-y-1">
          <p
            className="text-[10px] uppercase tracking-wider px-1"
            style={{ color: "rgba(255,255,255,0.3)" }}
          >
            Queue ({queue.length} songs)
          </p>
          <div
            className="max-h-48 overflow-y-auto space-y-0.5 rounded-lg"
            style={{ background: "rgba(0,0,0,0.2)" }}
          >
            {queue.map((t, i) => (
              <button
                type="button"
                key={`${t.spotifyTrackId}-${i}`}
                onClick={() => playFromQueue(i)}
                className={[
                  "w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2",
                  i === currentIndex
                    ? "bg-white/10 text-white"
                    : "text-white/50 hover:bg-white/5 hover:text-white/70",
                ].join(" ")}
              >
                <span
                  className="w-5 text-right tabular-nums text-[10px] shrink-0"
                  style={{ color: i === currentIndex ? "#e94560" : undefined }}
                >
                  {i === currentIndex ? "▶" : i + 1}
                </span>
                <span className="truncate">{t.trackName}</span>
                <span
                  className="ml-auto shrink-0 text-[10px]"
                  style={{ color: "rgba(255,255,255,0.3)" }}
                >
                  {t.artistName}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Footer hint */}
      <p
        className="text-[10px] text-center leading-relaxed mt-auto"
        style={{ color: "rgba(255,255,255,0.35)" }}
      >
        {mode === "connect" && selectedDeviceId
          ? "Audio plays on your device — keep going through screen lock."
          : "Open Spotify on your phone to play through screen lock."}
      </p>
    </div>
    </PlayerErrorBoundary>
  );
}

/* ─────────────────────────────────────────────────────────────── */
/*  Device picker                                                  */
/* ─────────────────────────────────────────────────────────────── */

function DevicePicker({
  devices,
  selectedDeviceId,
  selectedDevice,
  mode,
  loading,
  onSelect,
  onRefresh,
}: {
  devices: Array<{ id: string; name: string; type: string; is_active: boolean }>;
  selectedDeviceId: string | null;
  selectedDevice: { name: string; type: string } | null;
  mode: "connect" | "embed";
  loading: boolean;
  onSelect: (id: string) => void;
  onRefresh: () => void;
}) {
  const value = mode === "embed" ? "__embed__" : selectedDeviceId ?? "__embed__";

  return (
    <div
      className="rounded-lg px-3 py-2 flex items-center gap-2"
      style={{
        background: "rgba(255,255,255,0.05)",
        border: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      <span className="text-[10px] uppercase tracking-wider shrink-0"
        style={{ color: "rgba(255,255,255,0.4)" }}
      >
        Playing on
      </span>
      <select
        value={value}
        onChange={(e) => onSelect(e.target.value)}
        aria-label="Playback device"
        className="flex-1 min-w-0 bg-transparent text-xs text-white focus:outline-none truncate"
        style={{ colorScheme: "dark" }}
      >
        {devices.map((d) => (
          <option key={d.id} value={d.id}>
            {iconForType(d.type)} {d.name}
            {d.is_active ? " · active" : ""}
          </option>
        ))}
        <option value="__embed__">
          {devices.length === 0 ? "This browser (preview)" : "▷ This browser (preview)"}
        </option>
      </select>
      <button
        type="button"
        onClick={onRefresh}
        disabled={loading}
        title="Refresh device list"
        aria-label="Refresh device list"
        className="shrink-0 w-6 h-6 rounded flex items-center justify-center text-white/40 hover:text-white/80 hover:bg-white/10 transition-colors disabled:opacity-30"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          className={loading ? "animate-spin" : ""}
        >
          <path
            d="M3 12a9 9 0 0 1 15.5-6.3M21 12a9 9 0 0 1-15.5 6.3"
            strokeLinecap="round"
          />
          <path d="M21 4v5h-5M3 20v-5h5" strokeLinecap="round" />
        </svg>
      </button>
      {mode === "connect" && selectedDevice && (
        <span
          className="shrink-0 text-[10px] tabular-nums"
          style={{ color: "rgba(76, 217, 100, 0.9)" }}
        >
          ●
        </span>
      )}
    </div>
  );
}

function iconForType(type: string): string {
  const t = type.toLowerCase();
  if (t === "smartphone") return "📱";
  if (t === "computer") return "💻";
  if (t === "speaker") return "🔊";
  if (t === "tv") return "📺";
  if (t === "tablet") return "📱";
  return "🎵";
}

/* ─────────────────────────────────────────────────────────────── */
/*  Connect remote-control buttons                                 */
/* ─────────────────────────────────────────────────────────────── */

function ConnectControls({
  isPlaying,
  hasNext,
  hasPrev,
  onPrev,
  onNext,
  onTogglePause,
  deviceName,
}: {
  isPlaying: boolean;
  hasNext: boolean;
  hasPrev: boolean;
  onPrev: () => void;
  onNext: () => void;
  onTogglePause: () => void;
  deviceName: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2 py-3">
      <div className="flex items-center justify-center gap-3">
        <button
          type="button"
          onClick={onPrev}
          disabled={!hasPrev}
          aria-label="Previous track"
          className="w-10 h-10 rounded-full flex items-center justify-center transition-all disabled:opacity-25 active:scale-95"
          style={{
            background: "rgba(255,255,255,0.07)",
            border: "1px solid rgba(255,255,255,0.12)",
            color: "rgba(255,255,255,0.85)",
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />
          </svg>
        </button>

        <button
          type="button"
          onClick={onTogglePause}
          aria-label={isPlaying ? "Pause" : "Play"}
          className="w-14 h-14 rounded-full flex items-center justify-center active:scale-95 transition-all"
          style={{
            background: "linear-gradient(135deg, #e94560, #c93b50)",
            color: "white",
            boxShadow: "0 4px 12px rgba(233,69,96,0.4)",
          }}
        >
          {isPlaying ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 5h4v14H6zm8 0h4v14h-4z" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

        <button
          type="button"
          onClick={onNext}
          disabled={!hasNext}
          aria-label="Next track"
          className="w-10 h-10 rounded-full flex items-center justify-center transition-all disabled:opacity-25 active:scale-95"
          style={{
            background: "rgba(255,255,255,0.07)",
            border: "1px solid rgba(255,255,255,0.12)",
            color: "rgba(255,255,255,0.85)",
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 18l8.5-6L6 6v12zm10-12h2v12h-2z" />
          </svg>
        </button>
      </div>
      <p
        className="text-[10px] tracking-wide"
        style={{ color: "rgba(255,255,255,0.4)" }}
      >
        Remote · {deviceName}
      </p>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────── */
/*  Embed iframe (fallback / preview)                              */
/* ─────────────────────────────────────────────────────────────── */

function EmbedPlayer({
  trackId,
  onTrackEnd,
}: {
  trackId: string | null;
  onTrackEnd: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<any>(null); // eslint-disable-line @typescript-eslint/no-explicit-any
  const spotifyApiRef = useRef<any>(null); // eslint-disable-line @typescript-eslint/no-explicit-any
  const pendingTrackRef = useRef<string | null>(null);
  const advancedRef = useRef(false);
  const wasPlayingRef = useRef(false);
  const lastPositionRef = useRef(0);
  const onEndRef = useRef(onTrackEnd);
  onEndRef.current = onTrackEnd;

  // ── Shared helper: create and wire up the Spotify controller ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buildController = useRef((api: any, firstTrackId: string) => {
    const container = containerRef.current;
    if (!container || controllerRef.current) return;
    try {
      api.createController(
        container,
        { uri: toSpotifyTrackUri(firstTrackId), width: "100%", height: 152, theme: "0" },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (ctrl: any) => {
          controllerRef.current = ctrl;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ctrl.addListener("playback_update", (e: any) => {
            const data = e?.data;
            if (!data) return;
            const { isPaused, isBuffering, duration, position } = data;
            if (
              position + 5000 < lastPositionRef.current ||
              (position < 1500 && lastPositionRef.current > 5000)
            ) {
              advancedRef.current = false;
            }
            lastPositionRef.current = position;
            const wasPlaying = wasPlayingRef.current;
            wasPlayingRef.current = !isPaused && !isBuffering;
            if (advancedRef.current) return;
            const nearEnd = duration > 0 && position > 0 && duration - position < 3000;
            const reachedEnd = duration > 0 && position >= duration;
            if ((wasPlaying && isPaused && !isBuffering && nearEnd) || (reachedEnd && !isBuffering)) {
              advancedRef.current = true;
              setTimeout(() => onEndRef.current(), 300);
            }
          });
          // If another track arrived while controller was being created, switch to it.
          if (pendingTrackRef.current && pendingTrackRef.current !== firstTrackId) {
            try {
              ctrl.loadUri(toSpotifyTrackUri(pendingTrackRef.current));
              ctrl.play();
            } catch { /* ignore */ }
          }
          pendingTrackRef.current = null;
        }
      );
    } catch (err) {
      console.error("Spotify IFrame API error:", err);
    }
  });

  // ── Load Spotify IFrame API once ─────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function onApiReady(api: any) {
      spotifyApiRef.current = api;
      // Only create the controller immediately if a track is already queued.
      const id = pendingTrackRef.current;
      if (id) buildController.current(api, id);
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((window as any).SpotifyIframeApi) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onApiReady((window as any).SpotifyIframeApi);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).onSpotifyIframeApiReady = (api: any) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).SpotifyIframeApi = api;
          onApiReady(api);
        };
        if (!document.querySelector('script[src*="embed/iframe-api"]')) {
          const script = document.createElement("script");
          script.src = "https://open.spotify.com/embed/iframe-api/v1";
          script.async = true;
          document.body.appendChild(script);
        }
      }
    } catch (err) {
      console.error("Failed to initialise Spotify IFrame API:", err);
    }

    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).onSpotifyIframeApiReady = undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── When the track changes, load it ─────────────────────────
  useEffect(() => {
    if (!trackId) return;
    advancedRef.current = false;
    wasPlayingRef.current = false;
    lastPositionRef.current = 0;

    if (controllerRef.current) {
      // Controller already exists — switch track.
      try {
        controllerRef.current.loadUri(toSpotifyTrackUri(trackId));
        setTimeout(() => controllerRef.current?.play(), 300);
      } catch (err) {
        console.error("Spotify controller error:", err);
      }
    } else if (spotifyApiRef.current) {
      // API loaded but controller deferred (no track on mount) — create it now.
      pendingTrackRef.current = trackId;
      buildController.current(spotifyApiRef.current, trackId);
    } else {
      // API not loaded yet — queue the track for when it loads.
      pendingTrackRef.current = trackId;
    }
  }, [trackId]);

  return (
    <div
      ref={containerRef}
      className="rounded-xl overflow-hidden"
      style={{ minHeight: 152 }}
    />
  );
}

function toSpotifyTrackUri(trackIdOrUri: string): string {
  return trackIdOrUri.startsWith("spotify:track:")
    ? trackIdOrUri
    : `spotify:track:${trackIdOrUri}`;
}
