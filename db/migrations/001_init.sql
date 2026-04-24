create extension if not exists vector;

create table if not exists public.users (
  id uuid primary key,
  spotify_user_id text unique,
  created_at timestamptz not null default now()
);

create table if not exists public.artists (
  id bigserial primary key,
  spotify_artist_id text unique,
  name text not null,
  genres text[] not null default '{}',
  popularity int,
  musicbrainz_id text,
  lastfm_url text,
  embedding_source text,
  embedding vector(1024),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tracks (
  id bigserial primary key,
  spotify_track_id text unique not null,
  artist_id bigint references public.artists(id) on delete set null,
  name text not null,
  album_name text,
  duration_ms int,
  explicit boolean,
  popularity int,
  created_at timestamptz not null default now()
);

create table if not exists public.user_tracks (
  user_id uuid not null references public.users(id) on delete cascade,
  track_id bigint not null references public.tracks(id) on delete cascade,
  added_at timestamptz,
  play_count int not null default 0,
  last_played_at timestamptz,
  primary key (user_id, track_id)
);

create table if not exists public.listen_events (
  id bigserial primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  track_id bigint references public.tracks(id) on delete set null,
  listened_at timestamptz not null,
  source text not null default 'spotify_recent'
);

create table if not exists public.sources (
  id bigserial primary key,
  name text not null unique,
  kind text not null,
  url text not null,
  active boolean not null default true,
  trust_weight numeric(4,3) not null default 0.700,
  created_at timestamptz not null default now()
);

create table if not exists public.mentions (
  id bigserial primary key,
  source_id bigint not null references public.sources(id) on delete cascade,
  artist_id bigint references public.artists(id) on delete set null,
  artist_name_raw text,
  title text,
  url text,
  excerpt text,
  sentiment numeric(4,3),
  published_at timestamptz,
  embedding vector(1024),
  created_at timestamptz not null default now()
);

create index if not exists idx_artists_embedding on public.artists using ivfflat (embedding vector_cosine_ops);
create index if not exists idx_mentions_embedding on public.mentions using ivfflat (embedding vector_cosine_ops);
create index if not exists idx_user_tracks_user on public.user_tracks(user_id);
create index if not exists idx_mentions_artist on public.mentions(artist_id, published_at desc);
