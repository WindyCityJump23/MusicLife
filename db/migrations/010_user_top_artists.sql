-- Track the artists Spotify reports as a user's "top artists" per term so
-- they can contribute to the taste vector even when the user has no saved
-- tracks for them. Without this, /me/top/artists data lands in `artists`
-- but never produces user_tracks rows, so it never reaches the centroid.

create table if not exists public.user_top_artists (
  user_id   uuid    not null references public.users(id)   on delete cascade,
  artist_id bigint  not null references public.artists(id) on delete cascade,
  term      text    not null check (term in ('short_term', 'medium_term', 'long_term')),
  rank      int     not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, artist_id, term)
);

create index if not exists idx_user_top_artists_user on public.user_top_artists(user_id);

alter table public.user_top_artists enable row level security;

create policy user_top_artists_select_own on public.user_top_artists
  for select using (auth.uid() = user_id);

create policy user_top_artists_modify_own on public.user_top_artists
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
