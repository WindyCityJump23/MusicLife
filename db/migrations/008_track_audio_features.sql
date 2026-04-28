-- DEPRECATED: Spotify deprecated /audio-features for apps created after Nov 2024.
-- These columns may exist in production but are no longer populated.
-- The embedding-based context signal handles mood matching instead.
-- Safe to leave columns in place (all nullable); do not add new code that reads them.
--
-- Original purpose: Add Spotify audio features to tracks for song-level scoring.
-- Was fetched via GET /audio-features during library sync.

alter table public.tracks
  add column if not exists energy        real,      -- 0.0–1.0: intensity/activity
  add column if not exists danceability  real,      -- 0.0–1.0: suitable for dancing
  add column if not exists valence       real,      -- 0.0–1.0: musical positiveness (happy vs sad)
  add column if not exists tempo         real,      -- BPM
  add column if not exists acousticness  real,      -- 0.0–1.0: acoustic confidence
  add column if not exists instrumentalness real,   -- 0.0–1.0: no vocals confidence
  add column if not exists speechiness   real,      -- 0.0–1.0: spoken word presence
  add column if not exists loudness      real,      -- dB (typically -60 to 0)
  add column if not exists mode          smallint,  -- 0 = minor, 1 = major
  add column if not exists key           smallint;  -- 0–11 pitch class (C=0, C#=1, etc.)

-- Index for common query patterns (filter by mood/energy)
create index if not exists idx_tracks_audio_features
  on public.tracks(energy, valence, danceability)
  where energy is not null;
