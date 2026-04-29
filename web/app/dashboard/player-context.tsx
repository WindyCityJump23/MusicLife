"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";

export type QueueTrack = {
  spotifyTrackId: string;
  trackName: string;
  artistName: string;
};

type PlayerContextValue = {
  /** Current queue of tracks (from Discover results). */
  queue: QueueTrack[];

  /** Index of the currently playing track in the queue. */
  currentIndex: number;

  /** Play a specific track — sets it as current and loads the embed. */
  playFromQueue: (index: number) => void;

  /** Set the full queue (called when Discover results load). */
  setQueue: (tracks: QueueTrack[]) => void;

  /** Play a single track by ID (adds to queue if not present). */
  playSingle: (track: QueueTrack) => void;

  /** Advance to the next track in the queue. */
  playNext: () => void;

  /** Go to previous track. */
  playPrev: () => void;

  /** The Spotify track ID currently loaded in the embed player. */
  embedTrackId: string | null;

  /** Whether anything is actively playing. */
  isPlaying: boolean;

  /** Legacy compat — signals that the player panel should open. */
  playingArtist: string | null;

  /* SDK stubs for backward compat (unused now) */
  deviceId: string | null;
  setDeviceId: (id: string | null) => void;
  isReady: boolean;
  setIsReady: (v: boolean) => void;
  playArtist: (artistName: string) => Promise<{ ok: boolean; error?: string }>;
  playTrack: (spotifyTrackId: string) => Promise<{ ok: boolean; error?: string }>;
  setEmbedTrackId: (id: string | null) => void;
};

const PlayerContext = createContext<PlayerContextValue>({
  queue: [],
  currentIndex: -1,
  playFromQueue: () => {},
  setQueue: () => {},
  playSingle: () => {},
  playNext: () => {},
  playPrev: () => {},
  embedTrackId: null,
  isPlaying: false,
  playingArtist: null,
  deviceId: null,
  setDeviceId: () => {},
  isReady: false,
  setIsReady: () => {},
  playArtist: async () => ({ ok: false }),
  playTrack: async () => ({ ok: false }),
  setEmbedTrackId: () => {},
});

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const [queue, setQueueState] = useState<QueueTrack[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [embedTrackId, setEmbedTrackIdState] = useState<string | null>(null);

  const queueRef = useRef<QueueTrack[]>([]);
  const indexRef = useRef(-1);

  const setQueue = useCallback((tracks: QueueTrack[]) => {
    queueRef.current = tracks;
    setQueueState(tracks);
  }, []);

  const playFromQueue = useCallback((index: number) => {
    const q = queueRef.current;
    if (index < 0 || index >= q.length) return;
    indexRef.current = index;
    setCurrentIndex(index);
    setEmbedTrackIdState(q[index].spotifyTrackId);
  }, []);

  const playSingle = useCallback((track: QueueTrack) => {
    // Check if it's already in the queue
    const q = queueRef.current;
    const existingIdx = q.findIndex(t => t.spotifyTrackId === track.spotifyTrackId);
    if (existingIdx >= 0) {
      indexRef.current = existingIdx;
      setCurrentIndex(existingIdx);
      setEmbedTrackIdState(track.spotifyTrackId);
    } else {
      // Add to end of queue and play
      const newQueue = [...q, track];
      queueRef.current = newQueue;
      setQueueState(newQueue);
      const newIdx = newQueue.length - 1;
      indexRef.current = newIdx;
      setCurrentIndex(newIdx);
      setEmbedTrackIdState(track.spotifyTrackId);
    }
  }, []);

  const playNext = useCallback(() => {
    const q = queueRef.current;
    const nextIdx = indexRef.current + 1;
    if (nextIdx < q.length) {
      indexRef.current = nextIdx;
      setCurrentIndex(nextIdx);
      setEmbedTrackIdState(q[nextIdx].spotifyTrackId);
    }
  }, []);

  const playPrev = useCallback(() => {
    const prevIdx = indexRef.current - 1;
    if (prevIdx >= 0) {
      const q = queueRef.current;
      indexRef.current = prevIdx;
      setCurrentIndex(prevIdx);
      setEmbedTrackIdState(q[prevIdx].spotifyTrackId);
    }
  }, []);

  // Legacy compat
  const playingArtist = embedTrackId ? "playing" : null;

  // Legacy SDK stubs
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const playArtist = useCallback(async () => ({ ok: false as const, error: "Use embed player" }), []);
  const playTrack = useCallback(async (id: string) => {
    setEmbedTrackIdState(id);
    return { ok: true as const };
  }, []);

  return (
    <PlayerContext.Provider
      value={{
        queue,
        currentIndex,
        playFromQueue,
        setQueue,
        playSingle,
        playNext,
        playPrev,
        embedTrackId,
        isPlaying: embedTrackId !== null,
        playingArtist,
        deviceId,
        setDeviceId,
        isReady: false,
        setIsReady: () => {},
        playArtist,
        playTrack,
        setEmbedTrackId: setEmbedTrackIdState,
      }}
    >
      {children}
    </PlayerContext.Provider>
  );
}

export function usePlayer() {
  return useContext(PlayerContext);
}
