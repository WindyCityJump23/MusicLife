"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

export type QueueTrack = {
  spotifyTrackId: string;
  trackName: string;
  artistName: string;
};

export type ConnectDevice = {
  id: string;
  name: string;
  type: string;
  is_active: boolean;
  is_restricted: boolean;
  volume_percent: number | null;
};

/**
 * Two playback modes:
 *  - "connect": send playback to a Spotify Connect device (phone, etc.) so it
 *    keeps playing through screen lock — the gym scenario. Requires Premium.
 *  - "embed":   the existing in-page Spotify iframe (30s previews for free
 *    accounts, full plays for Premium-in-tab). Used as a fallback when no
 *    Connect device is online.
 */
export type PlayMode = "connect" | "embed";

type PlayerContextValue = {
  queue: QueueTrack[];
  currentIndex: number;

  /** Spotify Connect devices the user can play to. */
  devices: ConnectDevice[];
  selectedDeviceId: string | null;
  selectDevice: (id: string | null) => Promise<void>;
  refreshDevices: () => Promise<void>;
  devicesLoading: boolean;

  /** Active mode — drives which UI the Player renders. */
  mode: PlayMode;
  setMode: (m: PlayMode) => void;

  /** Send the queue to Spotify (Connect mode) or load the embed (embed mode). */
  playFromQueue: (index: number) => Promise<void>;
  setQueue: (tracks: QueueTrack[]) => void;
  playSingle: (track: QueueTrack) => Promise<void>;
  playNext: () => Promise<void>;
  playPrev: () => Promise<void>;
  togglePause: () => Promise<void>;

  /** Last known is-playing flag (refreshed by /api/now-playing poll). */
  isPlaying: boolean;
  setIsPlaying: (v: boolean) => void;

  /** Embed-mode track ID — drives the Spotify iframe when mode === "embed". */
  embedTrackId: string | null;

  /** Last error from a Connect API call (for surfacing in the player UI). */
  playbackError: string | null;
  clearPlaybackError: () => void;

  /** Legacy-compat surface (kept so other views compile unchanged). */
  playingArtist: string | null;
  deviceId: string | null;
  setDeviceId: (id: string | null) => void;
  isReady: boolean;
  setIsReady: (v: boolean) => void;
  playArtist: (artistName: string) => Promise<{ ok: boolean; error?: string }>;
  playTrack: (spotifyTrackId: string) => Promise<{ ok: boolean; error?: string }>;
  setEmbedTrackId: (id: string | null) => void;
};

const noop = () => {};
const noopAsync = async () => {};

type PlaybackResult = {
  ok: boolean;
  error?: string;
  reason?: string;
  status?: number;
};

/** Detect mobile browsers where Web Playback SDK won't work. */
function isMobileBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
}

function toSpotifyTrackId(value: string): string {
  return value.startsWith("spotify:track:") ? value.replace("spotify:track:", "") : value;
}

function toSpotifyTrackUri(value: string): string {
  return value.startsWith("spotify:track:") ? value : `spotify:track:${value}`;
}

const NOW_PLAYING_POLL_MS = 5_000;
const NOW_PLAYING_IDLE_POLL_MS = 15_000;
const NOW_PLAYING_HIDDEN_POLL_MS = 30_000;

/**
 * Open a Spotify URI in the native app. Uses the spotify: scheme
 * which deep-links on iOS/Android. Falls back to the web URL.
 */
function openInSpotifyApp(spotifyUri: string, webUrl: string): void {
  let didLeavePage = false;
  const markLeftPage = () => {
    if (document.hidden) didLeavePage = true;
  };

  document.addEventListener("visibilitychange", markLeftPage, { once: true });
  window.location.href = spotifyUri;

  setTimeout(() => {
    document.removeEventListener("visibilitychange", markLeftPage);
    if (!didLeavePage) {
      window.location.href = webUrl;
    }
  }, 1500);
}

const PlayerContext = createContext<PlayerContextValue>({
  queue: [],
  currentIndex: -1,
  devices: [],
  selectedDeviceId: null,
  selectDevice: noopAsync,
  refreshDevices: noopAsync,
  devicesLoading: false,
  mode: "embed",
  setMode: noop,
  playFromQueue: noopAsync,
  setQueue: noop,
  playSingle: noopAsync,
  playNext: noopAsync,
  playPrev: noopAsync,
  togglePause: noopAsync,
  isPlaying: false,
  setIsPlaying: noop,
  embedTrackId: null,
  playbackError: null,
  clearPlaybackError: noop,
  playingArtist: null,
  deviceId: null,
  setDeviceId: noop,
  isReady: false,
  setIsReady: noop,
  playArtist: async () => ({ ok: false }),
  playTrack: async () => ({ ok: false }),
  setEmbedTrackId: noop,
});

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const [queue, setQueueState] = useState<QueueTrack[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [embedTrackId, setEmbedTrackIdState] = useState<string | null>(null);
  const [devices, setDevices] = useState<ConnectDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [mode, setModeState] = useState<PlayMode>("embed");
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);

  const queueRef = useRef<QueueTrack[]>([]);
  const indexRef = useRef(-1);
  const modeRef = useRef<PlayMode>("embed");
  const deviceIdRef = useRef<string | null>(null);
  const isPlayingRef = useRef(false);

  // Keep refs in sync so async handlers see latest values.
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  useEffect(() => {
    deviceIdRef.current = selectedDeviceId;
  }, [selectedDeviceId]);
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  const setQueue = useCallback((tracks: QueueTrack[]) => {
    queueRef.current = tracks;
    setQueueState(tracks);
  }, []);

  const refreshDevices = useCallback(async () => {
    setDevicesLoading(true);
    try {
      const res = await fetch("/api/devices", { cache: "no-store" });
      if (!res.ok) {
        setDevices([]);
        return;
      }
      const data = await res.json();
      const list: ConnectDevice[] = data.devices ?? [];
      setDevices(list);

      // Auto-pick: keep current selection if it's still online; else prefer
      // the active device, then a phone, then anything.
      const current = deviceIdRef.current;
      const stillOnline = current && list.some((d) => d.id === current);
      if (!stillOnline) {
        const active = list.find((d) => d.is_active && !d.is_restricted);
        const phone = list.find(
          (d) => d.type.toLowerCase() === "smartphone" && !d.is_restricted
        );
        const any = list.find((d) => !d.is_restricted);
        const picked = (active ?? phone ?? any)?.id ?? null;
        deviceIdRef.current = picked;
        setSelectedDeviceId(picked);
        // If any usable Connect device exists, default to connect mode.
        if (picked) setModeState("connect");
      }
    } catch {
      setDevices([]);
    } finally {
      setDevicesLoading(false);
    }
  }, []);

  const setMode = useCallback((m: PlayMode) => {
    setModeState(m);
  }, []);

  const setEmbedTrackId = useCallback((id: string | null) => {
    setEmbedTrackIdState(id);
  }, []);

  const transferToDevice = useCallback(
    async (deviceId: string): Promise<PlaybackResult> => {
      const res = await fetch("/api/playback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "transfer", device_id: deviceId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return {
          ok: false,
          error: data.error ?? "Could not activate Spotify device",
          status: res.status,
        };
      }
      return { ok: true };
    },
    []
  );

  // ── Send a slice of the queue to Spotify (Connect mode) ───────
  const playOnConnect = useCallback(
    async (startIndex: number): Promise<PlaybackResult> => {
      const q = queueRef.current;
      if (startIndex < 0 || startIndex >= q.length) return { ok: false };

      const uris = q
        .map((t) => toSpotifyTrackUri(t.spotifyTrackId))
        .slice(0, 100); // Spotify cap
      const offset = Math.min(startIndex, uris.length - 1);

      const callPlayTrack = async (): Promise<PlaybackResult> => {
        const res = await fetch("/api/play-track", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            uris,
            offset_position: offset,
            device_id: deviceIdRef.current ?? undefined,
          }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          return {
            ok: false,
            error: data.error ?? "Playback failed",
            reason: data.reason,
            status: res.status,
          };
        }
        return { ok: true };
      };

      const deviceId = deviceIdRef.current;
      if (deviceId) {
        const transfer = await transferToDevice(deviceId);
        if (!transfer.ok) return transfer;
      }

      let result = await callPlayTrack();
      if (result.ok) return result;

      if (result.reason === "NO_ACTIVE_DEVICE" || result.status === 404) {
        await refreshDevices();
        const retryDeviceId = deviceIdRef.current;
        if (retryDeviceId) {
          const transfer = await transferToDevice(retryDeviceId);
          if (!transfer.ok) return transfer;
          result = await callPlayTrack();
        }
      }
      return result;
    },
    [refreshDevices, transferToDevice]
  );

  const playFromQueue = useCallback(
    async (index: number) => {
      const q = queueRef.current;
      if (index < 0 || index >= q.length) return;

      indexRef.current = index;
      setCurrentIndex(index);
      setPlaybackError(null);

      if (modeRef.current === "connect" && deviceIdRef.current) {
        const result = await playOnConnect(index);
        if (!result.ok) {
          if (isMobileBrowser()) {
            setPlaybackError(
              result.error
                ? `${result.error} Tap Open in Spotify to continue.`
                : "Could not start Spotify Connect. Tap Open in Spotify to continue."
            );
            setEmbedTrackIdState(q[index].spotifyTrackId);
            setModeState("embed");
            return;
          }
          setPlaybackError(result.error ?? "Playback failed");
          // Fallback to embed so the user still hears something.
          setEmbedTrackIdState(q[index].spotifyTrackId);
          setModeState("embed");
          return;
        }
        setIsPlaying(true);
        // Clear any embed track so the iframe stops competing for audio.
        setEmbedTrackIdState(null);
      } else if (isMobileBrowser()) {
        // Mobile deep-links are most reliable when fired immediately from the tap.
        setPlaybackError(null);
        const trackId = toSpotifyTrackId(q[index].spotifyTrackId);
        openInSpotifyApp(
          `spotify:track:${trackId}`,
          `https://open.spotify.com/track/${trackId}`
        );
        setIsPlaying(true);
        setEmbedTrackIdState(q[index].spotifyTrackId);
      } else {
        setEmbedTrackIdState(q[index].spotifyTrackId);
        setIsPlaying(true);
      }
    },
    [playOnConnect]
  );

  const playSingle = useCallback(
    async (track: QueueTrack) => {
      const q = queueRef.current;
      const existingIdx = q.findIndex(
        (t) => t.spotifyTrackId === track.spotifyTrackId
      );
      let index: number;
      if (existingIdx >= 0) {
        index = existingIdx;
      } else {
        const newQueue = [...q, track];
        queueRef.current = newQueue;
        setQueueState(newQueue);
        index = newQueue.length - 1;
      }
      await playFromQueue(index);
    },
    [playFromQueue]
  );

  const playNext = useCallback(async () => {
    const nextIdx = indexRef.current + 1;
    if (nextIdx >= queueRef.current.length) return;

    if (modeRef.current === "connect" && deviceIdRef.current) {
      const result = await playOnConnect(nextIdx);
      if (!result.ok) {
        setPlaybackError(result.error ?? "Skip failed");
        return;
      }
      indexRef.current = nextIdx;
      setCurrentIndex(nextIdx);
      return;
    }

    // Embed mode: advance our local index and reload the iframe.
    indexRef.current = nextIdx;
    setCurrentIndex(nextIdx);
    setEmbedTrackIdState(queueRef.current[nextIdx].spotifyTrackId);
  }, [playOnConnect]);

  const playPrev = useCallback(async () => {
    const prevIdx = indexRef.current - 1;
    if (prevIdx < 0) return;

    if (modeRef.current === "connect" && deviceIdRef.current) {
      const result = await playOnConnect(prevIdx);
      if (!result.ok) {
        setPlaybackError(result.error ?? "Previous failed");
        return;
      }
      indexRef.current = prevIdx;
      setCurrentIndex(prevIdx);
      return;
    }

    indexRef.current = prevIdx;
    setCurrentIndex(prevIdx);
    setEmbedTrackIdState(queueRef.current[prevIdx].spotifyTrackId);
  }, [playOnConnect]);

  const togglePause = useCallback(async () => {
    if (modeRef.current !== "connect" || !deviceIdRef.current) {
      // Embed mode pause/resume is handled by the iframe controls — no-op.
      return;
    }
    const action = isPlaying ? "pause" : "resume";
    const res = await fetch("/api/playback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        device_id: deviceIdRef.current,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setPlaybackError(data.error ?? "Pause/resume failed");
    } else {
      setIsPlaying(!isPlaying);
    }
  }, [isPlaying]);

  const clearPlaybackError = useCallback(() => setPlaybackError(null), []);

  const selectDevice = useCallback(
    async (id: string | null) => {
      deviceIdRef.current = id;
      setSelectedDeviceId(id);
      setPlaybackError(null);
      if (!id) return;

      setModeState("connect");
      const result = await transferToDevice(id);
      if (!result.ok) {
        setPlaybackError(result.error ?? "Could not activate Spotify device");
      }
    },
    [transferToDevice]
  );

  // ── Poll now-playing while in connect mode so UI reflects the
  //    actual device (user may pause/skip from their phone). ────
  useEffect(() => {
    if (mode !== "connect" || !selectedDeviceId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (delay: number) => {
      if (!cancelled) timer = setTimeout(tick, delay);
    };

    const tick = async () => {
      if (typeof document !== "undefined" && document.hidden) {
        schedule(NOW_PLAYING_HIDDEN_POLL_MS);
        return;
      }

      if (indexRef.current < 0 && !isPlayingRef.current) {
        schedule(NOW_PLAYING_IDLE_POLL_MS);
        return;
      }

      try {
        const res = await fetch("/api/now-playing", { cache: "no-store" });
        if (!cancelled && res.ok) {
          const data = await res.json();
          setIsPlaying(!!data.is_playing);
          // If the device on Spotify is one of our known devices, sync
          // selection so the dropdown reflects reality.
          if (data.device?.id) {
            setSelectedDeviceId((curr) =>
              curr === data.device.id ? curr : data.device.id
            );
          }
          if (data.item?.id) {
            const idx = queueRef.current.findIndex(
              (track) => toSpotifyTrackId(track.spotifyTrackId) === data.item.id
            );
            if (idx >= 0 && idx !== indexRef.current) {
              indexRef.current = idx;
              setCurrentIndex(idx);
            }
          }
        }
      } catch {
        /* ignore transient errors */
      }
      schedule(NOW_PLAYING_POLL_MS);
    };

    const handleVisibilityChange = () => {
      if (typeof document !== "undefined" && !document.hidden) {
        if (timer) clearTimeout(timer);
        void tick();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    tick();

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (timer) clearTimeout(timer);
    };
  }, [mode, selectedDeviceId]);

  // ── Legacy-compat shims ──────────────────────────────────────
  const playingArtist = embedTrackId || (mode === "connect" && currentIndex >= 0)
    ? "playing"
    : null;
  const playArtist = useCallback(
    async () => ({ ok: false as const, error: "Use playSingle" }),
    []
  );
  const playTrack = useCallback(
    async (id: string) => {
      await playSingle({
        spotifyTrackId: id,
        trackName: "",
        artistName: "",
      });
      return { ok: true as const };
    },
    [playSingle]
  );

  return (
    <PlayerContext.Provider
      value={{
        queue,
        currentIndex,
        devices,
        selectedDeviceId,
        selectDevice,
        refreshDevices,
        devicesLoading,
        mode,
        setMode,
        playFromQueue,
        setQueue,
        playSingle,
        playNext,
        playPrev,
        togglePause,
        isPlaying,
        setIsPlaying,
        embedTrackId,
        playbackError,
        clearPlaybackError,
        playingArtist,
        deviceId: selectedDeviceId,
        setDeviceId: setSelectedDeviceId,
        isReady: false,
        setIsReady: noop,
        playArtist,
        playTrack,
        setEmbedTrackId,
      }}
    >
      {children}
    </PlayerContext.Provider>
  );
}

export function usePlayer() {
  return useContext(PlayerContext);
}
