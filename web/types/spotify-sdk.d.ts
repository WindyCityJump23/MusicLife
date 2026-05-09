interface Window {
  Spotify: typeof Spotify;
  onSpotifyWebPlaybackSDKReady: () => void;
}

declare namespace Spotify {
  interface Player {
    connect(): Promise<boolean>;
    disconnect(): void;
    addListener(event: "ready", callback: (data: { device_id: string }) => void): void;
    addListener(event: "not_ready", callback: (data: { device_id: string }) => void): void;
    addListener(event: "player_state_changed", callback: (state: PlaybackState | null) => void): void;
    addListener(event: "initialization_error", callback: (data: { message: string }) => void): void;
    addListener(event: "authentication_error", callback: (data: { message: string }) => void): void;
    addListener(event: "account_error", callback: (data: { message: string }) => void): void;
    removeListener(event: string, callback?: (...args: unknown[]) => void): void;
    getCurrentState(): Promise<PlaybackState | null>;
    setName(name: string): Promise<void>;
    getVolume(): Promise<number>;
    setVolume(volume: number): Promise<void>;
    pause(): Promise<void>;
    resume(): Promise<void>;
    togglePlay(): Promise<void>;
    seek(position_ms: number): Promise<void>;
    previousTrack(): Promise<void>;
    nextTrack(): Promise<void>;
    activateElement(): Promise<void>;
  }

  interface PlayerInit {
    name: string;
    getOAuthToken: (cb: (token: string) => void) => void;
    volume?: number;
  }

  interface PlaybackState {
    context: { uri: string | null; metadata: Record<string, string> | null };
    disallows: Record<string, boolean>;
    duration: number;
    paused: boolean;
    position: number;
    repeat_mode: number;
    shuffle: boolean;
    track_window: {
      current_track: Track;
      previous_tracks: Track[];
      next_tracks: Track[];
    };
  }

  interface Track {
    uri: string;
    id: string | null;
    type: string;
    media_type: string;
    name: string;
    is_playable: boolean;
    album: { uri: string; name: string; images: Array<{ url: string; height: number; width: number }> };
    artists: Array<{ uri: string; name: string }>;
  }

  const Player: {
    new (options: PlayerInit): Player;
  };
}
