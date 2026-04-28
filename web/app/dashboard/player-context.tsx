"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";

type PlayerContextValue = {
  /** The Spotify Web Playback SDK device ID, set once the SDK is ready. */
  deviceId: string | null;
  setDeviceId: (id: string | null) => void;

  /** Whether the SDK player is connected and ready. */
  isReady: boolean;
  setIsReady: (v: boolean) => void;

  /** Play an artist by name on the SDK device.
   *  Returns { ok, error? }. Handles device transfer automatically. */
  playArtist: (artistName: string) => Promise<{ ok: boolean; error?: string }>;

  /** Currently playing indicator for the rec card that triggered playback. */
  playingArtist: string | null;
};

const PlayerContext = createContext<PlayerContextValue>({
  deviceId: null,
  setDeviceId: () => {},
  isReady: false,
  setIsReady: () => {},
  playArtist: async () => ({ ok: false, error: "no provider" }),
  playingArtist: null,
});

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [playingArtist, setPlayingArtist] = useState<string | null>(null);
  const deviceIdRef = useRef<string | null>(null);

  // Keep ref in sync so the async callback always reads the latest value
  const updateDeviceId = useCallback((id: string | null) => {
    deviceIdRef.current = id;
    setDeviceId(id);
  }, []);

  const playArtist = useCallback(async (artistName: string) => {
    setPlayingArtist(artistName);
    try {
      const res = await fetch("/api/play-artist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          artist_name: artistName,
          device_id: deviceIdRef.current ?? undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPlayingArtist(null);
        return { ok: false, error: data.error ?? "Playback failed" };
      }
      // Keep playingArtist set — Player will update via SDK state listener
      return { ok: true };
    } catch (err) {
      setPlayingArtist(null);
      return { ok: false, error: err instanceof Error ? err.message : "Network error" };
    }
  }, []);

  return (
    <PlayerContext.Provider
      value={{
        deviceId,
        setDeviceId: updateDeviceId,
        isReady,
        setIsReady,
        playArtist,
        playingArtist,
      }}
    >
      {children}
    </PlayerContext.Provider>
  );
}

export function usePlayer() {
  return useContext(PlayerContext);
}
