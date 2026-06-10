"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useAuth } from "./auth-context";

export type QueueTrack = {
  spotifyTrackId: string;
  trackName: string;
  artistName: string;
  trackId?: string | null;
  artistId?: string | null;
  stationRunId?: string | null;
  position?: number;
  prompt?: string;
  // Recommendation score at queue time; carried through play/skip events for
  // score-bucket calibration.
  score?: number;
};

export type ConnectDevice = {
  id: string;
  name: string;
  type: string;
  is_active: boolean;
  is_restricted: boolean;
  volume_percent: number | null;
};

export type PlayMode = "connect" | "embed";

type PlayerContextValue = {
  queue: QueueTrack[];
  currentIndex: number;

  devices: ConnectDevice[];
  selectedDeviceId: string | null;
  selectDevice: (id: string | null) => Promise<void>;
  refreshDevices: () => Promise<void>;
  devicesLoading: boolean;

  mode: PlayMode;
  setMode: (m: PlayMode) => void;

  playFromQueue: (index: number) => Promise<void>;
  setQueue: (tracks: QueueTrack[]) => void;
  playSingle: (track: QueueTrack) => Promise<void>;
  playNext: () => Promise<void>;
  playPrev: () => Promise<void>;
  togglePause: () => Promise<void>;

  isPlaying: boolean;
  setIsPlaying: (v: boolean) => void;

  embedTrackId: string | null;

  sdkPlayer: Spotify.Player | null;
  sdkDeviceId: string | null;
  sdkReady: boolean;
  sdkPosition: number;
  sdkDuration: number;
  albumArtUrl: string | null;

  playbackError: string | null;
  clearPlaybackError: () => void;

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

function toSpotifyTrackUri(value: string): string {
  return value.startsWith("spotify:track:") ? value : `spotify:track:${value}`;
}

function toSpotifyTrackId(value: string): string {
  return value.startsWith("spotify:track:") ? value.replace("spotify:track:", "") : value;
}

const NOW_PLAYING_POLL_MS = 5_000;
const NOW_PLAYING_IDLE_POLL_MS = 15_000;
const NOW_PLAYING_HIDDEN_POLL_MS = 30_000;
const MEANINGFUL_PLAY_MS = 30_000;

function intOrNull(value: string | null | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function logQueuePlaybackEvent(
  track: QueueTrack | null | undefined,
  eventType: "play" | "skip",
  dwellMs: number,
  metadata: Record<string, unknown> = {}
) {
  if (!track?.spotifyTrackId) return;
  const body = {
    event_type: eventType,
    station_run_id: track.stationRunId ?? null,
    spotify_track_id: track.spotifyTrackId,
    track_id: intOrNull(track.trackId),
    artist_id: intOrNull(track.artistId),
    position: track.position,
    prompt: track.prompt,
    source: "radio-player",
    dwell_ms: Math.max(0, Math.round(dwellMs)),
    metadata:
      typeof track.score === "number" ? { score: track.score, ...metadata } : metadata,
  };
  void fetch("/api/recommendation-event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => {});
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
  sdkPlayer: null,
  sdkDeviceId: null,
  sdkReady: false,
  sdkPosition: 0,
  sdkDuration: 0,
  albumArtUrl: null,
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
  const { isGuest, loading: authLoading } = useAuth();
  const [queue, setQueueState] = useState<QueueTrack[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [embedTrackId, setEmbedTrackIdState] = useState<string | null>(null);
  const [devices, setDevices] = useState<ConnectDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [mode, setModeState] = useState<PlayMode>("embed");
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);

  const [sdkPlayer, setSdkPlayer] = useState<Spotify.Player | null>(null);
  const [sdkDeviceId, setSdkDeviceId] = useState<string | null>(null);
  const [sdkReady, setSdkReady] = useState(false);
  const [sdkPosition, setSdkPosition] = useState(0);
  const [sdkDuration, setSdkDuration] = useState(0);
  const [albumArtUrl, setAlbumArtUrl] = useState<string | null>(null);

  const queueRef = useRef<QueueTrack[]>([]);
  const indexRef = useRef(-1);
  const modeRef = useRef<PlayMode>("embed");
  const deviceIdRef = useRef<string | null>(null);
  const isPlayingRef = useRef(false);
  const sdkPlayerRef = useRef<Spotify.Player | null>(null);
  const sdkDeviceIdRef = useRef<string | null>(null);
  const currentPlaybackTrackRef = useRef<QueueTrack | null>(null);
  const currentPlaybackIndexRef = useRef(-1);
  const playbackStartedAtRef = useRef<number | null>(null);
  const meaningfulPlayLoggedRef = useRef(false);
  const meaningfulPlayTimerRef = useRef<number | null>(null);

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { deviceIdRef.current = selectedDeviceId; }, [selectedDeviceId]);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { sdkPlayerRef.current = sdkPlayer; }, [sdkPlayer]);
  useEffect(() => { sdkDeviceIdRef.current = sdkDeviceId; }, [sdkDeviceId]);

  const setQueue = useCallback((tracks: QueueTrack[]) => {
    queueRef.current = tracks;
    setQueueState(tracks);
  }, []);

  const clearMeaningfulPlayTimer = useCallback(() => {
    if (meaningfulPlayTimerRef.current !== null) {
      window.clearTimeout(meaningfulPlayTimerRef.current);
      meaningfulPlayTimerRef.current = null;
    }
  }, []);

  const finalizeCurrentPlayback = useCallback((nextIndex: number) => {
    const current = currentPlaybackTrackRef.current;
    const startedAt = playbackStartedAtRef.current;
    if (!current || startedAt === null) return;

    const dwellMs = Date.now() - startedAt;
    clearMeaningfulPlayTimer();
    if (!meaningfulPlayLoggedRef.current) {
      if (dwellMs >= MEANINGFUL_PLAY_MS) {
        logQueuePlaybackEvent(current, "play", dwellMs, { completed_by: "transition" });
      } else if (nextIndex > currentPlaybackIndexRef.current) {
        logQueuePlaybackEvent(current, "skip", dwellMs, { completed_by: "advance" });
      }
    }
  }, [clearMeaningfulPlayTimer]);

  const beginPlaybackTracking = useCallback((track: QueueTrack, index: number) => {
    clearMeaningfulPlayTimer();
    currentPlaybackTrackRef.current = track;
    currentPlaybackIndexRef.current = index;
    playbackStartedAtRef.current = Date.now();
    meaningfulPlayLoggedRef.current = false;
    meaningfulPlayTimerRef.current = window.setTimeout(() => {
      if (currentPlaybackTrackRef.current?.spotifyTrackId !== track.spotifyTrackId) return;
      meaningfulPlayLoggedRef.current = true;
      logQueuePlaybackEvent(track, "play", MEANINGFUL_PLAY_MS, { completed_by: "timer" });
    }, MEANINGFUL_PLAY_MS);
  }, [clearMeaningfulPlayTimer]);

  useEffect(() => {
    return () => clearMeaningfulPlayTimer();
  }, [clearMeaningfulPlayTimer]);

  // ── SDK initialization (skip for guest users) ───────────────
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (authLoading || isGuest) return;

    let player: Spotify.Player | null = null;

    const initPlayer = () => {
      player = new window.Spotify.Player({
        name: "MusicLife",
        getOAuthToken: async (cb) => {
          try {
            const res = await fetch("/api/auth/token", { cache: "no-store" });
            if (res.ok) {
              const data = await res.json();
              cb(data.access_token);
            }
          } catch {
            // Token fetch failed — SDK will retry
          }
        },
        volume: 0.8,
      });

      player.addListener("ready", ({ device_id }) => {
        setSdkDeviceId(device_id);
        setSdkReady(true);
      });

      player.addListener("not_ready", () => {
        setSdkReady(false);
      });

      player.addListener("player_state_changed", (state) => {
        if (!state) {
          setIsPlaying(false);
          return;
        }
        setIsPlaying(!state.paused);
        setSdkPosition(state.position);
        setSdkDuration(state.duration);

        const images = state.track_window.current_track?.album?.images;
        if (images && images.length > 0) {
          const art = images.find((img) => img.height >= 200 && img.height <= 400) ?? images[0];
          setAlbumArtUrl(art.url);
        }

        if (modeRef.current !== "embed") return;

        const currentId = state.track_window.current_track?.id;
        if (currentId) {
          const idx = queueRef.current.findIndex(
            (t) => toSpotifyTrackId(t.spotifyTrackId) === currentId
          );
          if (idx >= 0 && idx !== indexRef.current) {
            indexRef.current = idx;
            setCurrentIndex(idx);
          }
        }
      });

      player.addListener("initialization_error", ({ message }) => {
        console.error("Spotify SDK init error:", message);
        setPlaybackError("Player failed to initialize. Try refreshing.");
      });

      player.addListener("authentication_error", ({ message }) => {
        console.error("Spotify SDK auth error:", message);
        setPlaybackError("Authentication error. Please sign out and back in.");
      });

      player.addListener("account_error", ({ message }) => {
        console.error("Spotify SDK account error:", message);
        setPlaybackError("Premium account required for playback.");
      });

      setSdkPlayer(player);
      player.connect();
    };

    if (window.Spotify?.Player) {
      initPlayer();
    } else {
      window.onSpotifyWebPlaybackSDKReady = initPlayer;
      if (!document.querySelector('script[src*="sdk.scdn.co/spotify-player"]')) {
        const script = document.createElement("script");
        script.src = "https://sdk.scdn.co/spotify-player.js";
        script.async = true;
        document.body.appendChild(script);
      }
    }

    return () => {
      if (player) {
        player.disconnect();
      }
    };
  }, [authLoading, isGuest]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Play a track via SDK (embed mode) ───────────────────────
  const pendingPlayRef = useRef<string | null>(null);

  const playViaSdk = useCallback(
    async (trackId: string) => {
      const devId = sdkDeviceIdRef.current;
      if (!devId) {
        pendingPlayRef.current = trackId;
        return;
      }
      pendingPlayRef.current = null;

      try {
        const player = sdkPlayerRef.current;
        if (player) await player.activateElement();

        const tokenRes = await fetch("/api/auth/token", { cache: "no-store" });
        if (!tokenRes.ok) {
          setPlaybackError("Could not get Spotify token. Try signing out and back in.");
          return;
        }
        const { access_token } = await tokenRes.json();

        const q = queueRef.current;
        const idx = indexRef.current;

        const uris =
          q.length > 1
            ? q.map((t) => toSpotifyTrackUri(t.spotifyTrackId))
            : [toSpotifyTrackUri(trackId)];
        const offset = q.length > 1 ? { position: Math.max(0, idx) } : { position: 0 };

        const res = await fetch(
          `https://api.spotify.com/v1/me/player/play?device_id=${devId}`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${access_token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ uris, offset }),
          }
        );

        if (res.status === 403) {
          setPlaybackError("Spotify Premium is required for in-browser playback.");
        } else if (!res.ok && res.status !== 204) {
          const err = await res.json().catch(() => ({}));
          setPlaybackError(err?.error?.message ?? `Playback failed (${res.status})`);
        }
      } catch {
        setPlaybackError("Could not start playback");
      }
    },
    []
  );

  // When embedTrackId changes, play via SDK
  useEffect(() => {
    if (!embedTrackId || modeRef.current !== "embed") return;
    void playViaSdk(embedTrackId);
  }, [embedTrackId, playViaSdk]);

  // When SDK becomes ready, play any pending track
  useEffect(() => {
    if (sdkReady && pendingPlayRef.current) {
      void playViaSdk(pendingPlayRef.current);
    }
  }, [sdkReady, playViaSdk]);

  // ── Position polling for progress bar ─────────────────────
  useEffect(() => {
    if (!isPlaying || mode !== "embed" || !sdkPlayer) return;
    const interval = setInterval(async () => {
      const state = await sdkPlayer.getCurrentState();
      if (state) {
        setSdkPosition(state.position);
        setSdkDuration(state.duration);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [isPlaying, mode, sdkPlayer]);

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

      const current = deviceIdRef.current;
      const stillOnline = current && list.some((d) => d.id === current && !d.is_restricted);
      if (!stillOnline) {
        deviceIdRef.current = null;
        setSelectedDeviceId(null);
        if (modeRef.current === "connect") setModeState("embed");
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

  useEffect(() => {
    if (isGuest) return;
    void refreshDevices();

    const onVisibilityChange = () => {
      if (!document.hidden) void refreshDevices();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [refreshDevices, isGuest]);

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

  const playOnConnect = useCallback(
    async (startIndex: number): Promise<PlaybackResult> => {
      const q = queueRef.current;
      if (startIndex < 0 || startIndex >= q.length) return { ok: false };

      const uris = q
        .map((t) => toSpotifyTrackUri(t.spotifyTrackId))
        .slice(0, 100);
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

      if (index !== indexRef.current) {
        finalizeCurrentPlayback(index);
      }

      indexRef.current = index;
      setCurrentIndex(index);
      setPlaybackError(null);
      beginPlaybackTracking(q[index], index);

      if (modeRef.current === "connect" && deviceIdRef.current) {
        const result = await playOnConnect(index);
        if (!result.ok) {
          setPlaybackError(result.error ?? "Playback failed");
          setEmbedTrackIdState(q[index].spotifyTrackId);
          setModeState("embed");
          return;
        }
        setIsPlaying(true);
        setEmbedTrackIdState(null);
      } else {
        setEmbedTrackIdState(q[index].spotifyTrackId);
        setIsPlaying(true);
      }
    },
    [beginPlaybackTracking, finalizeCurrentPlayback, playOnConnect]
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
    finalizeCurrentPlayback(nextIdx);

    if (modeRef.current === "connect" && deviceIdRef.current) {
      const result = await playOnConnect(nextIdx);
      if (!result.ok) {
        setPlaybackError(result.error ?? "Skip failed");
        return;
      }
      indexRef.current = nextIdx;
      setCurrentIndex(nextIdx);
      beginPlaybackTracking(queueRef.current[nextIdx], nextIdx);
      return;
    }

    indexRef.current = nextIdx;
    setCurrentIndex(nextIdx);
    setEmbedTrackIdState(queueRef.current[nextIdx].spotifyTrackId);
    beginPlaybackTracking(queueRef.current[nextIdx], nextIdx);
  }, [beginPlaybackTracking, finalizeCurrentPlayback, playOnConnect]);

  const playPrev = useCallback(async () => {
    const prevIdx = indexRef.current - 1;
    if (prevIdx < 0) return;
    finalizeCurrentPlayback(prevIdx);

    if (modeRef.current === "connect" && deviceIdRef.current) {
      const result = await playOnConnect(prevIdx);
      if (!result.ok) {
        setPlaybackError(result.error ?? "Previous failed");
        return;
      }
      indexRef.current = prevIdx;
      setCurrentIndex(prevIdx);
      beginPlaybackTracking(queueRef.current[prevIdx], prevIdx);
      return;
    }

    indexRef.current = prevIdx;
    setCurrentIndex(prevIdx);
    setEmbedTrackIdState(queueRef.current[prevIdx].spotifyTrackId);
    beginPlaybackTracking(queueRef.current[prevIdx], prevIdx);
  }, [beginPlaybackTracking, finalizeCurrentPlayback, playOnConnect]);

  const togglePause = useCallback(async () => {
    if (modeRef.current === "embed") {
      const player = sdkPlayerRef.current;
      if (!player) return;
      await player.togglePlay();
      return;
    }

    if (!deviceIdRef.current) return;
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

  // ── Poll now-playing while in connect mode ──────────────────
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
        sdkPlayer,
        sdkDeviceId,
        sdkReady,
        sdkPosition,
        sdkDuration,
        albumArtUrl,
        playbackError,
        clearPlaybackError,
        playingArtist,
        deviceId: selectedDeviceId,
        setDeviceId: setSelectedDeviceId,
        isReady: sdkReady,
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
