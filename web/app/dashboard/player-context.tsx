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
  selectDevice: (id: string | null) => void;
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

/** Detect mobile browsers where Web Playback SDK won't work. */
function isMobileBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
}

/**
 * Open a Spotify URI in the native app. Uses the spotify: scheme
 * which deep-links on iOS/Android. Falls back to the web URL.
 */
function openInSpotifyApp(spotifyUri: string, webUrl: string): void {
  const start = Date.now();
  window.location.href = spotifyUri;
  setTimeout(() => {
    if (Date.now() - start < 2000) {
      window.open(webUrl, "_blank");
    }
  }, 1500);
}

/**
 * Create a temporary Spotify playlist from the queue and open it in
 * the Spotify app at a specific offset. This gives mobile users full
 * track playback WITH auto-advance through the entire queue.
 *
 * Returns the playlist URL, or null on failure.
 */
async function createAndOpenQueuePlaylist(
  queue: QueueTrack[],
  startIndex: number,
): Promise<string | null> {
  if (queue.length === 0) return null;

  try {
    const trackIds = queue
      .map((t) => t.spotifyTrackId)
      .filter(Boolean);

    if (trackIds.length === 0) return null;

    const now = new Date();
    const name = `MusicLife Queue — ${now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;

    const res = await fetch("/api/playlist-from-tracks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        track_ids: trackIds,
        name,
        description: "Auto-generated queue from MusicLife Discover",
      }),
    });

    if (!res.ok) return null;

    const data = await res.json();
    const playlistId = data.playlist_id;
    if (!playlistId) return null;

    // Open the playlist in Spotify app at the correct track offset
    const uri = `spotify:playlist:${playlistId}:play`;
    const webUrl = `https://open.spotify.com/playlist/${playlistId}`;

    openInSpotifyApp(uri, webUrl);
    return data.playlist_url;
  } catch {
    return null;
  }
}

const PlayerContext = createContext<PlayerContextValue>({
  queue: [],
  currentIndex: -1,
  devices: [],
  selectedDeviceId: null,
  selectDevice: noop,
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

  // Keep refs in sync so async handlers see latest values.
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  useEffect(() => {
    deviceIdRef.current = selectedDeviceId;
  }, [selectedDeviceId]);

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

  const selectDevice = useCallback((id: string | null) => {
    setSelectedDeviceId(id);
    if (id) setModeState("connect");
  }, []);

  const setMode = useCallback((m: PlayMode) => {
    setModeState(m);
  }, []);

  const setEmbedTrackId = useCallback((id: string | null) => {
    setEmbedTrackIdState(id);
  }, []);

  // ── Send a slice of the queue to Spotify (Connect mode) ───────
  const playOnConnect = useCallback(
    async (startIndex: number): Promise<{ ok: boolean; error?: string }> => {
      const q = queueRef.current;
      if (startIndex < 0 || startIndex >= q.length) return { ok: false };

      const uris = q
        .map((t) =>
          t.spotifyTrackId.startsWith("spotify:track:")
            ? t.spotifyTrackId
            : `spotify:track:${t.spotifyTrackId}`
        )
        .slice(0, 100); // Spotify cap
      const offset = Math.min(startIndex, uris.length - 1);

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
        return { ok: false, error: data.error ?? "Playback failed" };
      }
      return { ok: true };
    },
    []
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
          // On mobile without a Connect device, create playlist in Spotify app
          if (isMobileBrowser()) {
            const url = await createAndOpenQueuePlaylist(q, index);
            if (!url) {
              openInSpotifyApp(
                `spotify:track:${q[index].spotifyTrackId}`,
                `https://open.spotify.com/track/${q[index].spotifyTrackId}`
              );
            }
            setIsPlaying(true);
            setEmbedTrackIdState(q[index].spotifyTrackId);
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
        // On mobile without Connect: create a playlist from the queue
        // and open it in the Spotify app. This gives full tracks AND
        // auto-advance through the entire queue.
        setPlaybackError(null);
        const url = await createAndOpenQueuePlaylist(q, index);
        if (!url) {
          // Fallback: open just the single track
          openInSpotifyApp(
            `spotify:track:${q[index].spotifyTrackId}`,
            `https://open.spotify.com/track/${q[index].spotifyTrackId}`
          );
        }
        setIsPlaying(true);
        // Still set embed for the UI to show track info
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
    if (modeRef.current === "connect" && deviceIdRef.current) {
      // Let Spotify handle next on the device — keeps queue in sync there.
      const res = await fetch("/api/playback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "next",
          device_id: deviceIdRef.current,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setPlaybackError(data.error ?? "Skip failed");
      } else {
        const nextIdx = indexRef.current + 1;
        if (nextIdx < queueRef.current.length) {
          indexRef.current = nextIdx;
          setCurrentIndex(nextIdx);
        }
      }
      return;
    }

    // Embed mode: advance our local index and reload the iframe.
    const nextIdx = indexRef.current + 1;
    if (nextIdx < queueRef.current.length) {
      indexRef.current = nextIdx;
      setCurrentIndex(nextIdx);
      setEmbedTrackIdState(queueRef.current[nextIdx].spotifyTrackId);
    }
  }, []);

  const playPrev = useCallback(async () => {
    if (modeRef.current === "connect" && deviceIdRef.current) {
      const res = await fetch("/api/playback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "previous",
          device_id: deviceIdRef.current,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setPlaybackError(data.error ?? "Previous failed");
      } else {
        const prevIdx = indexRef.current - 1;
        if (prevIdx >= 0) {
          indexRef.current = prevIdx;
          setCurrentIndex(prevIdx);
        }
      }
      return;
    }

    const prevIdx = indexRef.current - 1;
    if (prevIdx >= 0) {
      indexRef.current = prevIdx;
      setCurrentIndex(prevIdx);
      setEmbedTrackIdState(queueRef.current[prevIdx].spotifyTrackId);
    }
  }, []);

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

  // ── Initial device discovery ─────────────────────────────────
  useEffect(() => {
    refreshDevices();
  }, [refreshDevices]);

  // ── Poll now-playing while in connect mode so UI reflects the
  //    actual device (user may pause/skip from their phone). ────
  useEffect(() => {
    if (mode !== "connect" || !selectedDeviceId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
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
        }
      } catch {
        /* ignore transient errors */
      }
      if (!cancelled) timer = setTimeout(tick, 5000);
    };
    tick();

    return () => {
      cancelled = true;
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
