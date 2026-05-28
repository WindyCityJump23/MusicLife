-- 9+ Radio reliability, learning events, and observability.

create extension if not exists vector;
create extension if not exists pgcrypto;

create table if not exists public.station_cache (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  cache_key text not null,
  prompt text,
  strategy jsonb not null default '{}'::jsonb,
  results jsonb not null,
  source_mix jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);

create index if not exists idx_station_cache_user_expires
  on public.station_cache(user_id, expires_at desc, created_at desc);

create unique index if not exists idx_station_cache_user_key
  on public.station_cache(user_id, cache_key);

alter table public.station_cache enable row level security;

drop policy if exists station_cache_select_own on public.station_cache;
create policy station_cache_select_own on public.station_cache
  for select using ((select auth.uid()) = user_id);

drop policy if exists station_cache_modify_own on public.station_cache;
create policy station_cache_modify_own on public.station_cache
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create table if not exists public.station_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  prompt text,
  strategy jsonb not null default '{}'::jsonb,
  status text not null default 'started'
    check (status in ('started', 'success', 'partial', 'cache', 'starter', 'empty', 'error')),
  fallback_level text not null default 'fresh'
    check (fallback_level in ('fresh', 'partial', 'cache', 'starter', 'empty')),
  result_count int not null default 0,
  latency_ms int,
  source_mix jsonb not null default '{}'::jsonb,
  error_class text,
  created_at timestamptz not null default now()
);

create index if not exists idx_station_runs_user_created
  on public.station_runs(user_id, created_at desc);

alter table public.station_runs enable row level security;

drop policy if exists station_runs_select_own on public.station_runs;
create policy station_runs_select_own on public.station_runs
  for select using ((select auth.uid()) = user_id);

drop policy if exists station_runs_modify_own on public.station_runs;
create policy station_runs_modify_own on public.station_runs
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create table if not exists public.recommendation_events (
  id bigserial primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  station_run_id uuid,
  spotify_track_id text,
  track_id bigint references public.tracks(id) on delete set null,
  artist_id bigint references public.artists(id) on delete set null,
  event_type text not null check (
    event_type in (
      'impression',
      'play',
      'skip',
      'thumb_up',
      'thumb_down',
      'too_familiar',
      'too_far',
      'favorite',
      'save_playlist',
      'open_spotify'
    )
  ),
  position int,
  prompt text,
  source text not null default 'radio',
  dwell_ms int,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_recommendation_events_user_created
  on public.recommendation_events(user_id, created_at desc);

create index if not exists idx_recommendation_events_user_type
  on public.recommendation_events(user_id, event_type, created_at desc);

create index if not exists idx_recommendation_events_track
  on public.recommendation_events(user_id, spotify_track_id, created_at desc)
  where spotify_track_id is not null;

alter table public.recommendation_events enable row level security;

drop policy if exists recommendation_events_select_own on public.recommendation_events;
create policy recommendation_events_select_own on public.recommendation_events
  for select using ((select auth.uid()) = user_id);

drop policy if exists recommendation_events_modify_own on public.recommendation_events;
create policy recommendation_events_modify_own on public.recommendation_events
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

alter table public.user_feedback
  add column if not exists reason text;

do $$
begin
  alter table public.user_feedback
    add constraint user_feedback_reason_chk
    check (
      reason is null or reason in (
        'more_like_this',
        'less_like_this',
        'too_familiar',
        'too_far',
        'wrong_prompt',
        'liked'
      )
    );
exception
  when duplicate_object then null;
end $$;

create table if not exists public.taste_snapshots (
  id bigserial primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  generated_at timestamptz not null default now(),
  top_genres jsonb not null default '[]'::jsonb,
  anchor_artists jsonb not null default '[]'::jsonb,
  feedback_summary jsonb not null default '{}'::jsonb,
  readiness jsonb not null default '{}'::jsonb,
  thesis text
);

create index if not exists idx_taste_snapshots_user_generated
  on public.taste_snapshots(user_id, generated_at desc);

alter table public.taste_snapshots enable row level security;

drop policy if exists taste_snapshots_select_own on public.taste_snapshots;
create policy taste_snapshots_select_own on public.taste_snapshots
  for select using ((select auth.uid()) = user_id);

drop policy if exists taste_snapshots_modify_own on public.taste_snapshots;
create policy taste_snapshots_modify_own on public.taste_snapshots
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create or replace function public.match_tracks(
  query_embedding vector(1024),
  match_count int default 100,
  genre_tokens text[] default null
)
returns table (
  id bigint,
  name text,
  artist_id bigint,
  album_name text,
  release_date date,
  duration_ms int,
  popularity int,
  spotify_track_id text,
  explicit boolean,
  energy real,
  danceability real,
  valence real,
  tempo real,
  acousticness real,
  instrumentalness real,
  speechiness real,
  similarity double precision
)
language sql
stable
as $$
  select
    t.id,
    t.name,
    t.artist_id,
    t.album_name,
    t.release_date,
    t.duration_ms,
    t.popularity,
    t.spotify_track_id,
    t.explicit,
    t.energy,
    t.danceability,
    t.valence,
    t.tempo,
    t.acousticness,
    t.instrumentalness,
    t.speechiness,
    case
      when query_embedding is null or t.embedding is null then 0
      else 1 - (t.embedding <=> query_embedding)
    end as similarity
  from public.tracks t
  join public.artists a on a.id = t.artist_id
  where t.spotify_track_id is not null
    and t.embedding is not null
    and (
      genre_tokens is null
      or exists (
        select 1
        from unnest(a.genres) as g
        where exists (
          select 1
          from unnest(genre_tokens) as token
          where lower(g) like '%' || lower(token) || '%'
        )
      )
    )
  order by
    case
      when query_embedding is null then coalesce(t.popularity, 0)
      else 1 - (t.embedding <=> query_embedding)
    end desc
  limit greatest(1, least(match_count, 1000));
$$;

grant execute on function public.match_tracks(vector(1024), int, text[]) to authenticated;
grant execute on function public.match_tracks(vector(1024), int, text[]) to service_role;
