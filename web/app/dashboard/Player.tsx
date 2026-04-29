"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { usePlayer } from "./player-context";

// ── Spotify Web Playback SDK types ───────────────────────────────
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
type SpotifyImage  = { url: string };
type SpotifyTrack  = {
  name: string;
  artists: SpotifyArtist[];
  album?: { images?: SpotifyImage[] };
};
type SpotifyState = {
  paused: boolean;
  position: number;
  duration: number;
  track_window: { current_track: SpotifyTrack | null };
};
type SpotifyPlayer = {
  connect:       () => Promise<boolean>;
  disconnect:    () => void;
  togglePlay:    () => Promise<void>;
  previousTrack: () => Promise<void>;
  nextTrack:     () => Promise<void>;
  setVolume:     (v: number) => Promise<void>;
  addListener:   (event: string, cb: (payload: any) => void) => boolean;
};

type Track = { name: string; artists: string; albumArt: string | null };
type Status =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "unauth" }
  | { kind: "error"; message: string };

const SDK_SRC = "https://sdk.scdn.co/spotify-player.js";

function formatMs(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ── Component ────────────────────────────────────────────────────
export default function Player() {
  const playerCtx = usePlayer();
  const { embedTrackId } = playerCtx;
  const [status,      setStatus]      = useState<Status>({ kind: "loading" });
  const [deviceId,    setDeviceId]    = useState<string | null>(null);
  const [track,       setTrack]       = useState<Track | null>(null);
  const [paused,      setPaused]      = useState(true);
  const [transferring,setTransferring]= useState(false);
  const [volume,      setVolume]      = useState(50);
  const [position,    setPosition]    = useState(0);
  const [duration,    setDuration]    = useState(0);

  const playerRef          = useRef<SpotifyPlayer | null>(null);
  const initRef            = useRef(false);
  const progressIntervalRef= useRef<ReturnType<typeof setInterval> | null>(null);

  // ── SDK init ─────────────────────────────────────────────────
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
            if (!res.ok) { setStatus({ kind: "unauth" }); return; }
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
        playerCtx.setDeviceId(device_id);
        playerCtx.setIsReady(true);
        setStatus({ kind: "ready" });
      });
      player.addListener("not_ready", () => {});
      player.addListener("player_state_changed", (s: SpotifyState | null) => {
        if (!s) return;
        const t = s.track_window.current_track;
        if (t) {
          setTrack({
            name:     t.name,
            artists:  t.artists.map((a) => a.name).join(", "),
            albumArt: t.album?.images?.[0]?.url ?? null,
          });
        }
        setPaused(s.paused);
        setPosition(s.position);
        setDuration(s.duration);
      });
      player.addListener("initialization_error", ({ message }) =>
        setStatus({ kind: "error", message })
      );
      player.addListener("authentication_error", () =>
        setStatus({ kind: "unauth" })
      );
      player.addListener("account_error", ({ message }) =>
        setStatus({ kind: "error", message: `Spotify Premium required (${message})` })
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
        script.src       = SDK_SRC;
        script.async     = true;
        script.dataset.spotifySdk = "true";
        document.body.appendChild(script);
      }
    }

    return () => {
      window.onSpotifyWebPlaybackSDKReady = undefined;
      playerRef.current?.disconnect();
      playerRef.current = null;
    };
  }, []);

  // ── Progress ticker ──────────────────────────────────────────
  useEffect(() => {
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
    if (!paused) {
      progressIntervalRef.current = setInterval(
        () => setPosition((p) => p + 1000),
        1000
      );
    }
    return () => {
      if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);
    };
  }, [paused]);

  // ── Transfer playback ────────────────────────────────────────
  async function transferPlayback() {
    if (!deviceId || transferring) return;
    setTransferring(true);
    try {
      const tokenRes = await fetch("/api/auth/token", { cache: "no-store" });
      if (!tokenRes.ok) { setStatus({ kind: "unauth" }); return; }
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

  // ── Volume ───────────────────────────────────────────────────
  async function handleVolumeChange(v: number) {
    setVolume(v);
    if (playerRef.current) {
      await playerRef.current.setVolume(v / 100);
    }
  }

  const progressPct = duration > 0 ? Math.min((position / duration) * 100, 100) : 0;
  const isReady     = status.kind === "ready";

  // ── Render ───────────────────────────────────────────────────
  return (
    <div
      className="rounded-2xl flex flex-col gap-4 p-5 min-h-full"
      style={{ background: "linear-gradient(160deg, #1a1a2e 0%, #16213e 60%, #0f3460 100%)" }}
    >
      {/* ── Header ─────────────────────────────────────────── */}
      <div className="text-center">
        <p
          className="text-[10px] font-bold tracking-[0.25em] uppercase"
          style={{ color: "#e94560" }}
        >
          ♫ Now Playing
        </p>
      </div>

      {/* ── Album art or idle state ─────────────────────── */}
      {track ? (
        <div className="flex flex-col items-center gap-4">
          {/* Spinning vinyl disc */}
          <div
            className={`relative rounded-full overflow-hidden flex-shrink-0 w-44 h-44 sm:w-52 sm:h-52 lg:w-48 lg:h-48 ${
              !paused ? "vinyl-spin glow-playing" : "vinyl-spin-paused"
            }`}
            style={{
              boxShadow: paused
                ? "0 4px 24px rgba(0,0,0,0.6)"
                : undefined,
            }}
          >
            {track.albumArt ? (
              <Image
                src={track.albumArt}
                alt={track.name}
                fill
                sizes="(max-width: 640px) 176px, (max-width: 1024px) 208px, 192px"
                className="object-cover"
                priority
              />
            ) : (
              <div
                className="w-full h-full flex items-center justify-center text-5xl"
                style={{ background: "#0f3460" }}
              >
                🎵
              </div>
            )}
            {/* Vinyl center hole overlay */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div
                className="w-7 h-7 rounded-full"
                style={{
                  background: "#1a1a2e",
                  border: "2px solid rgba(255,255,255,0.15)",
                  boxShadow: "0 0 0 4px rgba(0,0,0,0.25)",
                }}
              />
            </div>
          </div>

          {/* Track info */}
          <div className="text-center w-full px-1">
            <div className="text-white font-semibold text-sm leading-snug truncate">
              {track.name}
            </div>
            <div
              className="text-xs truncate mt-0.5"
              style={{ color: "rgba(255,255,255,0.55)" }}
            >
              {track.artists}
            </div>
          </div>
        </div>
      ) : (
        /* Idle state */
        <div className="flex flex-col items-center gap-3 py-4 idle-float">
          <div
            className="w-36 h-36 sm:w-40 sm:h-40 rounded-full flex items-center justify-center idle-rotate"
            style={{
              background: "radial-gradient(circle, #0f3460 0%, #1a1a2e 80%)",
              border: "3px solid rgba(233,69,96,0.3)",
              boxShadow: "0 0 20px rgba(233,69,96,0.15)",
            }}
          >
            <span className="text-6xl select-none">🎵</span>
          </div>
          <div className="text-center space-y-1">
            <p className="text-white font-medium text-sm">Drop a record</p>
            <p className="text-xs" style={{ color: "rgba(255,255,255,0.4)" }}>
              {isReady
                ? "Transfer playback to start streaming"
                : status.kind === "loading"
                ? "Connecting to Spotify…"
                : "Waiting for player…"}
            </p>
          </div>
        </div>
      )}

      {/* ── Progress bar ───────────────────────────────────── */}
      <div className="space-y-1">
        <div
          className="w-full h-1.5 rounded-full overflow-hidden"
          style={{ background: "rgba(255,255,255,0.1)" }}
        >
          <div
            className="h-full rounded-full transition-all duration-1000"
            style={{
              width: `${progressPct}%`,
              background: "linear-gradient(90deg, #e94560, #f5a623)",
            }}
          />
        </div>
        <div
          className="flex justify-between text-[10px] tabular-nums"
          style={{ color: "rgba(255,255,255,0.35)" }}
        >
          <span>{formatMs(position)}</span>
          <span>{formatMs(duration)}</span>
        </div>
      </div>

      {/* ── Playback controls ──────────────────────────────── */}
      <div className="flex items-center justify-center gap-3">
        <JukeboxButton
          onClick={() => playerRef.current?.previousTrack()}
          disabled={!isReady}
          aria-label="Previous track"
        >
          <PrevIcon />
        </JukeboxButton>

        <JukeboxButton
          onClick={() => playerRef.current?.togglePlay()}
          disabled={!isReady}
          primary
          aria-label={paused ? "Play" : "Pause"}
        >
          {paused ? <PlayIcon /> : <PauseIcon />}
        </JukeboxButton>

        <JukeboxButton
          onClick={() => playerRef.current?.nextTrack()}
          disabled={!isReady}
          aria-label="Next track"
        >
          <NextIcon />
        </JukeboxButton>
      </div>

      {/* ── Volume slider ──────────────────────────────────── */}
      <div className="flex items-center gap-2">
        <span className="text-sm" style={{ color: "rgba(255,255,255,0.4)" }}>
          {volume === 0 ? "🔇" : volume < 50 ? "🔉" : "🔊"}
        </span>
        <input
          type="range"
          min={0}
          max={100}
          value={volume}
          onChange={(e) => handleVolumeChange(Number(e.target.value))}
          disabled={!isReady}
          aria-label="Volume"
          className="flex-1 h-2 rounded-full appearance-none disabled:opacity-40 cursor-pointer"
          style={
            {
              accentColor: "#e94560",
              background: `linear-gradient(to right, #e94560 ${volume}%, rgba(255,255,255,0.15) ${volume}%)`,
            } as React.CSSProperties
          }
        />
        <span
          className="text-[10px] w-5 text-right tabular-nums"
          style={{ color: "rgba(255,255,255,0.35)" }}
        >
          {volume}
        </span>
      </div>

      {/* ── Transfer playback ──────────────────────────────── */}
      <button
        onClick={transferPlayback}
        disabled={!isReady || !deviceId || transferring}
        className="w-full py-2 rounded-xl text-xs font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        style={{
          background: "rgba(255,255,255,0.06)",
          border: "1px solid rgba(255,255,255,0.12)",
          color: "rgba(255,255,255,0.7)",
        }}
        onMouseEnter={(e) =>
          (e.currentTarget.style.background = "rgba(233,69,96,0.18)")
        }
        onMouseLeave={(e) =>
          (e.currentTarget.style.background = "rgba(255,255,255,0.06)")
        }
      >
        {transferring ? "Transferring…" : "⇄ Transfer to this tab"}
      </button>

      {/* ── Status ─────────────────────────────────────────── */}
      <StatusLine status={status} />

      {/* ── Spotify Embed Player (works without Premium) ──── */}
      {embedTrackId && (
        <div className="mt-3 rounded-xl overflow-hidden">
          <iframe
            src={`https://open.spotify.com/embed/track/${embedTrackId}?utm_source=generator&theme=0`}
            width="100%"
            height="152"
            frameBorder="0"
            allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
            loading="lazy"
            style={{ borderRadius: "12px" }}
          />
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────

function StatusLine({ status }: { status: Status }) {
  if (status.kind === "ready") {
    return (
      <div className="flex items-center gap-1.5 justify-center">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        <span className="text-[10px] text-emerald-400">Connected</span>
      </div>
    );
  }
  if (status.kind === "loading") {
    return (
      <div className="flex items-center gap-1.5 justify-center">
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{ background: "rgba(255,255,255,0.3)" }}
        />
        <span
          className="text-[10px]"
          style={{ color: "rgba(255,255,255,0.4)" }}
        >
          Connecting…
        </span>
      </div>
    );
  }
  if (status.kind === "unauth") {
    return (
      <div className="text-[10px] text-amber-400 text-center">
        Session expired —{" "}
        <a href="/api/auth/login" className="underline hover:text-amber-300">
          reconnect Spotify
        </a>
      </div>
    );
  }
  return (
    <div className="text-[10px] text-red-400 text-center">{status.message}</div>
  );
}

function JukeboxButton({
  onClick,
  disabled,
  primary = false,
  children,
  "aria-label": ariaLabel,
}: {
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  children: React.ReactNode;
  "aria-label"?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className="flex items-center justify-center rounded-full transition-all disabled:opacity-40 disabled:cursor-not-allowed active:scale-95"
      style={
        primary
          ? {
              width: 52,
              height: 52,
              background: "linear-gradient(135deg, #e94560, #c73652)",
              boxShadow: "0 4px 16px rgba(233,69,96,0.45), inset 0 1px 0 rgba(255,255,255,0.15)",
              border: "none",
              color: "white",
            }
          : {
              width: 40,
              height: 40,
              background: "rgba(255,255,255,0.07)",
              border: "1px solid rgba(255,255,255,0.12)",
              color: "rgba(255,255,255,0.8)",
            }
      }
    >
      {children}
    </button>
  );
}

// ── Icons ─────────────────────────────────────────────────────────

function PlayIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}
function PauseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
    </svg>
  );
}
function PrevIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />
    </svg>
  );
}
function NextIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 18l8.5-6L6 6v12zm2.5-6 5.5 3.9V8.1L8.5 12zM16 6h2v12h-2z" />
    </svg>
  );
}
