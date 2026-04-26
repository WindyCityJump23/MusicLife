"use client";

import { useEffect, useRef, useState } from "react";

// Spotify Web Playback SDK lives on window.Spotify and signals readiness
// via a global onSpotifyWebPlaybackSDKReady callback the SDK script invokes.
declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady?: () => void;
    Spotify?: {
      Player: new (opts: SpotifyPlayerOptions) => SpotifyPlayer;
    };
  }
}

type SpotifyPlayerOptions = {
  name: string;
  getOAuthToken: (cb: (token: string) => void) => void;
  volume?: number;
};

type SpotifyArtist = { name: string };
type SpotifyImage = { url: string };
type SpotifyTrack = {
  name: string;
  artists: SpotifyArtist[];
  album?: { images?: SpotifyImage[] };
};
type SpotifyState = {
  paused: boolean;
  track_window: { current_track: SpotifyTrack | null };
};

type SpotifyPlayer = {
  connect: () => Promise<boolean>;
  disconnect: () => void;
  togglePlay: () => Promise<void>;
  previousTrack: () => Promise<void>;
  nextTrack: () => Promise<void>;
  addListener: (event: string, cb: (payload: any) => void) => boolean;
};

type Track = { name: string; artists: string; albumArt: string | null };

type Status =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "unauth" }
  | { kind: "error"; message: string };

const SDK_SRC = "https://sdk.scdn.co/spotify-player.js";

export default function Player() {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [track, setTrack] = useState<Track | null>(null);
  const [paused, setPaused] = useState(true);
  const [transferring, setTransferring] = useState(false);
  const playerRef = useRef<SpotifyPlayer | null>(null);
  const initRef = useRef(false);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    const init = () => {
      if (!window.Spotify) {
        setStatus({ kind: "error", message: "SDK failed to load" });
        return;
      }

      const player = new window.Spotify.Player({
        name: "Music Dashboard",
        getOAuthToken: async (cb) => {
          try {
            const res = await fetch("/api/auth/token", { cache: "no-store" });
            if (!res.ok) {
              setStatus({ kind: "unauth" });
              return;
            }
            const data = await res.json();
            if (data.access_token) cb(data.access_token);
          } catch {
            setStatus({ kind: "unauth" });
          }
        },
        volume: 0.5,
      });

      player.addListener("ready", ({ device_id }) => {
        setDeviceId(device_id);
        setStatus({ kind: "ready" });
      });
      player.addListener("not_ready", () => {
        // Device dropped; the SDK will try to reconnect on its own.
      });
      player.addListener("player_state_changed", (s: SpotifyState | null) => {
        if (!s) return;
        const t = s.track_window.current_track;
        if (t) {
          setTrack({
            name: t.name,
            artists: t.artists.map((a) => a.name).join(", "),
            albumArt: t.album?.images?.[0]?.url ?? null,
          });
        }
        setPaused(s.paused);
      });
      player.addListener("initialization_error", ({ message }) =>
        setStatus({ kind: "error", message })
      );
      player.addListener("authentication_error", () =>
        setStatus({ kind: "unauth" })
      );
      player.addListener("account_error", ({ message }) =>
        setStatus({
          kind: "error",
          message: `Spotify Premium required (${message})`,
        })
      );

      player.connect();
      playerRef.current = player;
    };

    if (window.Spotify) {
      init();
    } else {
      window.onSpotifyWebPlaybackSDKReady = init;
      if (!document.querySelector(`script[data-spotify-sdk]`)) {
        const script = document.createElement("script");
        script.src = SDK_SRC;
        script.async = true;
        script.dataset.spotifySdk = "true";
        document.body.appendChild(script);
      }
    }

    return () => {
      playerRef.current?.disconnect();
      playerRef.current = null;
    };
  }, []);

  async function transferPlayback() {
    if (!deviceId || transferring) return;
    setTransferring(true);
    try {
      const tokenRes = await fetch("/api/auth/token", { cache: "no-store" });
      if (!tokenRes.ok) {
        setStatus({ kind: "unauth" });
        return;
      }
      const { access_token } = await tokenRes.json();
      await fetch("https://api.spotify.com/v1/me/player", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${access_token}`,
        },
        body: JSON.stringify({ device_ids: [deviceId], play: false }),
      });
    } finally {
      setTransferring(false);
    }
  }

  return (
    <div className="space-y-4">
      <StatusLine status={status} />

      {track ? (
        <div className="space-y-3">
          {track.albumArt && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={track.albumArt}
              alt={track.name}
              className="w-full aspect-square object-cover rounded-md border border-neutral-200"
            />
          )}
          <div>
            <div className="text-sm font-medium text-neutral-900 truncate">{track.name}</div>
            <div className="text-xs text-neutral-500 truncate">{track.artists}</div>
          </div>
        </div>
      ) : (
        <div className="border border-dashed border-neutral-300 rounded-md p-6 text-center text-xs text-neutral-500">
          {status.kind === "ready"
            ? "Ready. Transfer playback to start streaming here."
            : "Waiting for player…"}
        </div>
      )}

      <div className="flex items-center gap-2">
        <ControlButton
          onClick={() => playerRef.current?.previousTrack()}
          disabled={status.kind !== "ready"}
          label="Prev"
        />
        <ControlButton
          onClick={() => playerRef.current?.togglePlay()}
          disabled={status.kind !== "ready"}
          label={paused ? "Play" : "Pause"}
          primary
        />
        <ControlButton
          onClick={() => playerRef.current?.nextTrack()}
          disabled={status.kind !== "ready"}
          label="Next"
        />
      </div>

      <button
        onClick={transferPlayback}
        disabled={status.kind !== "ready" || !deviceId || transferring}
        className="w-full px-2.5 py-1.5 rounded border border-neutral-200 bg-white text-xs text-neutral-700 hover:bg-neutral-50 hover:border-neutral-300 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {transferring ? "Transferring…" : "Transfer playback to this tab"}
      </button>
    </div>
  );
}

function StatusLine({ status }: { status: Status }) {
  if (status.kind === "ready") {
    return <div className="text-[11px] text-emerald-600">Connected</div>;
  }
  if (status.kind === "loading") {
    return <div className="text-[11px] text-neutral-400">Connecting…</div>;
  }
  if (status.kind === "unauth") {
    return (
      <div className="text-[11px] text-amber-600">
        Session expired —{" "}
        <a href="/api/auth/login" className="underline">
          reconnect Spotify
        </a>
      </div>
    );
  }
  return <div className="text-[11px] text-red-500">{status.message}</div>;
}

function ControlButton({
  onClick,
  disabled,
  label,
  primary = false,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
  primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={[
        "flex-1 px-2 py-1.5 rounded text-xs font-medium border transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
        primary
          ? "bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700"
          : "bg-white text-neutral-700 border-neutral-200 hover:bg-neutral-50",
      ].join(" ")}
    >
      {label}
    </button>
  );
}
