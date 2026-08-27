-- Track-level recognizability.
--
-- Migration 028 added artist-level Last.fm listener counts as the
-- recognizability proxy after Spotify's popularity scores went NULL. That
-- fixed the artist axis but left every track inside an artist's catalog
-- indistinguishable: the ranker fell back to the artist's percentile for all
-- of them, so a signature song and a filler album cut scored identically and
-- the shortlist picked between them at random.
--
-- Last.fm's track.getInfo returns per-track listeners/playcount, which is a
-- genuine within-catalog quality signal. These columns hold it.
--
-- Columns are nullable: ranking treats NULL as "no track signal" and falls
-- back to the artist percentile exactly as before, so this migration is safe
-- to apply before or after the code deploy.

alter table public.tracks
  add column if not exists lastfm_listeners bigint,
  add column if not exists lastfm_playcount bigint;

comment on column public.tracks.lastfm_listeners is
  'Last.fm per-track listener count (within-catalog recognizability). 0 = looked up but not found; NULL = not yet fetched.';
comment on column public.tracks.lastfm_playcount is
  'Last.fm per-track playcount, captured alongside listeners.';

-- Partial index over the resumable backfill predicate so repeated runs of
-- the track-stats job do not seq-scan the whole tracks table.
create index if not exists tracks_lastfm_listeners_pending_idx
  on public.tracks (id)
  where lastfm_listeners is null;

-- Extend match_tracks to return the new column so prompted searches carry
-- the same recognizability signal as the catalog path.
-- CREATE OR REPLACE cannot change a function's return table, so drop and
-- recreate. Callers read rows as dicts and tolerate the extra key in
-- either deploy order.
drop function if exists public.match_tracks(vector, int, text[]);

create function public.match_tracks(
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
  lastfm_listeners bigint,
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
    t.lastfm_listeners,
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
