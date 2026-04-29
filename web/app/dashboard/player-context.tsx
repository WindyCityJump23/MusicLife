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

  /** Play a specific track by Spotify track ID on the SDK device.
   *  Returns { ok, error? }. Much more direct than playArtist. */
  playTrack: (spotifyTrackId: string) => Promise<{ ok: boolean; error?: string }>;

  /** Currently playing indicator for the rec card that triggered playback. */
  playingArtist: string | null;

  /** Spotify track ID to show in the embed player (works without Premium). */
  embedTrackId: string | null;
  setEmbedTrackId: (id: string | null) => void;
};

const PlayerContext = createContext<PlayerContextValue>({
  deviceId: null,
  setDeviceId: () => {},
  isReady: false,
  setIsReady: () => {},
  playArtist: async () => ({ ok: false, error: "no provider" }),
  playTrack: async () => ({ ok: false, error: "no provider" }),
  playingArtist: null,
  embedTrackId: null,
  setEmbedTrackId: () => {},
});

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [playingArtist, setPlayingArtist] = useState<string | null>(null);
  const [embedTrackId, setEmbedTrackId] = useState<string | null>(null);
  const deviceIdRef = useRef<string | null>(null);

  // Keep ref in sync so the async callback always reads the latest value
  const updateDeviceId = useCallback((id: string | null) => {
    deviceIdRef.current = id;
    setDeviceId(id);
  }, []);

  // Auto-transfer playback to the SDK device before playing
  const autoTransfer = useCallback(async () => {
    const did = deviceIdRef.current;
    if (!did) return;
    try {
      const tokenRes = await fetch("/api/auth/token", { cache: "no-store" });
      if (!tokenRes.ok) return;
      const { access_token } = await tokenRes.json();
      if (!access_token) return;
      await fetch("https://api.spotify.com/v1/me/player", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${access_token}`,
        },
        body: JSON.stringify({ device_ids: [did], play: false }),
      });
    } catch {
      // Best effort — don't block playback if transfer fails
    }
  }, []);

  const playArtist = useCallback(async (artistName: string) => {
    setPlayingArtist(artistName);
    await autoTransfer();
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
      return { ok: true };
    } catch (err) {
      setPlayingArtist(null);
      return { ok: false, error: err instanceof Error ? err.message : "Network error" };
    }
  }, []);

  const playTrack = useCallback(async (spotifyTrackId: string) => {
    setPlayingArtist(spotifyTrackId);
    await autoTransfer();
    try {
      const res = await fetch("/api/play-track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          spotify_track_id: spotifyTrackId,
          device_id: deviceIdRef.current ?? undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPlayingArtist(null);
        return { ok: false, error: data.error ?? "Playback failed" };
      }
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
        playTrack,
        playingArtist,
        embedTrackId,
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
