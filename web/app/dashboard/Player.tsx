"use client";

import { useEffect, useRef } from "react";
import { usePlayer } from "./player-context";

/**
 * Player panel.
 *
 * Two modes:
 *  - "embed"   — Spotify iframe in this page. This is the default path; the
 *    listening experience stays inside MusicLife.
 *  - "connect" — optional remote-control of a Spotify Connect device when the
 *    user explicitly picks one from the device selector.
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
  const isConnectMode = mode === "connect" && Boolean(selectedDevice);
  const playbackLabel = isConnectMode
    ? `Remote on ${selectedDevice?.name ?? "Spotify device"}`
    : "Browser player";
  const playbackTone = isConnectMode ? "connect" : "preview";

  return (
    <div
      className="rounded-lg flex flex-col gap-4 p-5 min-h-full"
      style={{
        background:
          "linear-gradient(160deg, #1a1a2e 0%, #16213e 60%, #0f3460 100%)",
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <p
            className="text-[10px] font-bold uppercase"
            style={{ color: "#e94560" }}
          >
            Now Playing
          </p>
          <p className="text-xs text-white/45">{playbackLabel}</p>
        </div>
        <span
          className="shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold uppercase"
          style={{
            background:
              playbackTone === "connect"
                ? "rgba(76, 217, 100, 0.16)"
                : "rgba(255,255,255,0.08)",
            color:
              playbackTone === "connect"
                ? "rgba(140, 255, 170, 0.95)"
                : "rgba(255,255,255,0.62)",
          }}
        >
          {isConnectMode ? "Connect" : "Browser"}
        </span>
      </div>

      {/* Current track info */}
      {currentTrack ? (
        <div className="px-1">
          <p className="text-white font-semibold text-base leading-snug truncate">
            {currentTrack.trackName}
          </p>
          <p
            className="text-sm mt-0.5 truncate"
            style={{ color: "rgba(255,255,255,0.55)" }}
          >
            {currentTrack.artistName}
          </p>
        </div>
      ) : (
        <div className="px-1">
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
            void selectDevice(null);
          } else {
            void selectDevice(id);
          }
        }}
        onRefresh={refreshDevices}
      />

      <PlaybackStatus
        mode={mode}
        hasDevice={Boolean(selectedDevice)}
        deviceName={selectedDevice?.name ?? null}
        devicesLoading={devicesLoading}
        deviceCount={usableDevices.length}
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
            onClick={clearPlaybackError}
            aria-label="Dismiss error"
            className="opacity-60 hover:opacity-100"
          >
            ×
          </button>
        </div>
      )}

      {/* Mode-specific player */}
      {isConnectMode ? (
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
                key={`${t.spotifyTrackId}-${i}`}
                onClick={() => playFromQueue(i)}
                className={[
                  "w-full text-left px-3 py-2 text-xs transition-colors grid grid-cols-[1.5rem_minmax(0,1fr)_minmax(0,0.8fr)] items-center gap-2",
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
                <span className="truncate font-medium">{t.trackName}</span>
                <span
                  className="min-w-0 truncate text-right text-[10px]"
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
          ? "Audio plays on your device — keeps going through screen lock."
          : "Playback stays in MusicLife. Save a playlist when you want to export it."}
      </p>
    </div>
  );
}

function PlaybackStatus({
  mode,
  hasDevice,
  deviceName,
  devicesLoading,
  deviceCount,
}: {
  mode: "connect" | "embed";
  hasDevice: boolean;
  deviceName: string | null;
  devicesLoading: boolean;
  deviceCount: number;
}) {
  let title = "Browser player";
  let detail = "Songs load in the embedded player so the experience stays in MusicLife.";

  if (mode === "connect" && hasDevice) {
    title = "Queue ready";
    detail = `Playing through ${deviceName ?? "your Spotify device"} with native queue handoff.`;
  } else if (devicesLoading) {
    title = "Finding devices";
    detail = "Checking for optional Connect devices. Browser playback remains available.";
  } else if (deviceCount === 0) {
    title = "Ready in browser";
    detail = "No Connect device is selected, so playback will stay in MusicLife.";
  }

  return (
    <div
      className="rounded-lg px-3 py-2"
      style={{
        background:
          mode === "connect" && hasDevice
            ? "rgba(76,217,100,0.1)"
            : "rgba(255,255,255,0.05)",
        border:
          mode === "connect" && hasDevice
            ? "1px solid rgba(76,217,100,0.22)"
            : "1px solid rgba(255,255,255,0.08)",
      }}
    >
      <p className="text-xs font-medium text-white">{title}</p>
      <p className="mt-0.5 text-[11px] leading-relaxed text-white/45">{detail}</p>
    </div>
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
  const statusText =
    loading && devices.length === 0
      ? "Finding devices"
      : mode === "connect" && selectedDevice
      ? selectedDevice.name
      : "This browser";

  return (
    <div
      className="rounded-lg px-3 py-2 space-y-2"
      style={{
        background: "rgba(255,255,255,0.05)",
        border: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase shrink-0 text-white/40">
          Playing on
        </span>
        <span className="min-w-0 truncate text-[10px] text-white/45">
          {statusText}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <select
          value={value}
          onChange={(e) => onSelect(e.target.value)}
          aria-label="Playback device"
          className="flex-1 min-w-0 bg-transparent text-xs text-white focus:outline-none truncate disabled:text-white/35"
          style={{ colorScheme: "dark" }}
          disabled={loading && devices.length === 0}
        >
          {loading && devices.length === 0 && (
            <option value="__embed__">Finding Spotify devices...</option>
          )}
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {iconForType(d.type)} {d.name}
              {d.is_active ? " · active" : ""}
            </option>
          ))}
          <option value="__embed__">▷ This browser</option>
        </select>
        <button
          onClick={onRefresh}
          disabled={loading}
          title="Refresh device list"
          aria-label="Refresh device list"
          className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-white/45 hover:text-white/85 hover:bg-white/10 transition-colors disabled:opacity-30"
        >
          <svg
            width="14"
            height="14"
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

function toSpotifyTrackUri(value: string): string {
  return value.startsWith("spotify:track:") ? value : `spotify:track:${value}`;
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
  const pendingRef = useRef<string | null>(null);
  const advancedRef = useRef(false);
  const wasPlayingRef = useRef(false);
  const lastPositionRef = useRef(0);
  const onEndRef = useRef(onTrackEnd);
  onEndRef.current = onTrackEnd;

  // Load Spotify IFrame API once and create the controller.
  useEffect(() => {
    if (typeof window === "undefined") return;

    function onApiReady(IFrameAPI: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
      const container = containerRef.current;
      if (!container) return;

      const initialId =
        pendingRef.current || trackId || "4cOdK2wGLETKBW3PvgPWqT";
      const uri = toSpotifyTrackUri(initialId);

      IFrameAPI.createController(
        container,
        { uri, width: "100%", height: 152, theme: "0" },
        (ctrl: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          controllerRef.current = ctrl;

          ctrl.addListener("playback_update", (e: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
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

            const nearEnd =
              duration > 0 && position > 0 && duration - position < 3000;
            const reachedEnd = duration > 0 && position >= duration;
            const justEnded =
              wasPlaying && isPaused && !isBuffering && nearEnd;

            if ((justEnded || reachedEnd) && !isBuffering) {
              advancedRef.current = true;
              setTimeout(() => onEndRef.current(), 300);
            }
          });

          if (pendingRef.current) {
            ctrl.loadUri(toSpotifyTrackUri(pendingRef.current));
            ctrl.play();
            pendingRef.current = null;
          }
        }
      );
    }

    if ((window as any).SpotifyIframeApi) { // eslint-disable-line @typescript-eslint/no-explicit-any
      onApiReady((window as any).SpotifyIframeApi); // eslint-disable-line @typescript-eslint/no-explicit-any
    } else {
      (window as any).onSpotifyIframeApiReady = (IFrameAPI: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        (window as any).SpotifyIframeApi = IFrameAPI; // eslint-disable-line @typescript-eslint/no-explicit-any
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
      (window as any).onSpotifyIframeApiReady = undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the requested track changes, load it into the existing controller.
  useEffect(() => {
    if (!trackId) return;
    advancedRef.current = false;
    wasPlayingRef.current = false;
    lastPositionRef.current = 0;

    if (controllerRef.current) {
      controllerRef.current.loadUri(toSpotifyTrackUri(trackId));
      controllerRef.current.play();
    } else {
      pendingRef.current = trackId;
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
