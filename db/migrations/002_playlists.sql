create table if not exists public.playlists (
  id bigserial primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  name text not null,
  description text,
  visibility text not null default 'private',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.playlist_items (
  id bigserial primary key,
  playlist_id bigint not null references public.playlists(id) on delete cascade,
  artist_id bigint references public.artists(id) on delete set null,
  track_id bigint references public.tracks(id) on delete set null,
  rank int,
  reason text,
  created_at timestamptz not null default now(),
  constraint playlist_items_target_chk check (artist_id is not null or track_id is not null)
);

create unique index if not exists idx_playlist_items_rank
  on public.playlist_items(playlist_id, rank)
  where rank is not null;

create index if not exists idx_playlists_user on public.playlists(user_id, updated_at desc);
