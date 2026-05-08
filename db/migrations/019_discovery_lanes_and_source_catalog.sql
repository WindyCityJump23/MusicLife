-- Make discovery history useful for radio-style novelty.
-- Existing history only stores track ids/signature, which prevents the
-- ranker from avoiding repeated artists and from learning whether a run was
-- hit-heavy or deep-cut-heavy.

alter table public.discover_history
  add column if not exists artist_ids bigint[] not null default '{}',
  add column if not exists lanes text[] not null default '{}',
  add column if not exists prompt_mode text,
  add column if not exists result_meta jsonb not null default '{}'::jsonb;

create index if not exists idx_discover_history_artist_ids
  on public.discover_history using gin (artist_ids);

create index if not exists idx_discover_history_lanes
  on public.discover_history using gin (lanes);

-- Fast lookup for editorial/catalog expansion artists created from Spotify.
create index if not exists idx_artists_spotify_artist_id
  on public.artists(spotify_artist_id)
  where spotify_artist_id is not null;
