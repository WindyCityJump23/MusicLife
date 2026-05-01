alter table public.tracks
  add column if not exists release_date date;

create index if not exists idx_tracks_release_date on public.tracks(release_date);
