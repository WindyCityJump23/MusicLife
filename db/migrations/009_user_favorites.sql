-- Track user favorites (hearts) for recommendation learning.
-- Each row represents a user favoriting a specific track from a recommendation.
-- This data feeds back into the recommendation engine to improve future results.

create table if not exists public.user_favorites (
  id bigserial primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  track_id bigint references public.tracks(id) on delete set null,
  spotify_track_id text not null,
  artist_name text,
  track_name text,
  source text not null default 'discover',   -- where they favorited from: discover, playlists, etc.
  score real,                                  -- the recommendation score at time of favorite
  created_at timestamptz not null default now()
);

-- Prevent duplicate favorites
create unique index if not exists idx_user_favorites_dedup
  on public.user_favorites(user_id, spotify_track_id);

create index if not exists idx_user_favorites_user
  on public.user_favorites(user_id, created_at desc);

-- RLS
alter table public.user_favorites enable row level security;

create policy user_favorites_select_own on public.user_favorites
  for select using (auth.uid() = user_id);

create policy user_favorites_modify_own on public.user_favorites
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
