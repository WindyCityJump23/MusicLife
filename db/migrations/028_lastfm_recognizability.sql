-- Last.fm recognizability proxy.
--
-- Spotify stopped returning popularity scores for tracks and artists
-- (mid-2026 API change) — production has popularity NULL for every row,
-- which silently emptied the radio_hits lane and flattened the popularity
-- axis of ranking. Last.fm listener counts become the recognizability
-- proxy; ranking converts them to pool-relative percentiles.
--
-- Columns are nullable: ranking treats NULL as neutral (0.5), so this
-- migration is safe to apply before or after the code deploy.

alter table public.artists
  add column if not exists lastfm_listeners bigint,
  add column if not exists lastfm_playcount bigint;

comment on column public.artists.lastfm_listeners is
  'Last.fm global listener count (recognizability proxy after Spotify removed popularity). 0 = looked up but not found; NULL = not yet fetched.';
comment on column public.artists.lastfm_playcount is
  'Last.fm global playcount, captured alongside listeners.';

-- Extend the candidate-pool RPC to return lastfm_listeners so the ranker
-- gets recognizability without an extra round trip.
-- CREATE OR REPLACE cannot change a function's return table, so drop and
-- recreate (one migration = one transaction). Callers read rows as dicts
-- and tolerate the extra key in either deploy order.
drop function if exists public.match_artists_by_embedding(vector, int, bigint[], text[]);

create function public.match_artists_by_embedding(
  query_embedding vector(1024) default null,
  match_count int default 200,
  exclude_ids bigint[] default array[]::bigint[],
  genre_tokens text[] default null
)
returns table(
  id bigint,
  name text,
  popularity int,
  genres text[],
  spotify_artist_id text,
  similarity real,
  lastfm_listeners bigint
)
language sql stable as $$
  select
    a.id,
    a.name,
    a.popularity,
    a.genres,
    a.spotify_artist_id,
    case
      when query_embedding is not null
        then (1 - (a.embedding <=> query_embedding))::real
      else 0.0::real
    end as similarity,
    a.lastfm_listeners
  from public.artists a
  where a.embedding is not null
    and (
      exclude_ids is null
      or array_length(exclude_ids, 1) is null
      or not (a.id = any(exclude_ids))
    )
    and (
      genre_tokens is null
      or array_length(genre_tokens, 1) is null
      or exists (
        select 1 from unnest(a.genres) g
        where exists (
          select 1 from unnest(genre_tokens) t
          where lower(g) like '%' || lower(t) || '%'
        )
      )
    )
  order by
    case when query_embedding is not null then a.embedding <=> query_embedding else 0 end,
    coalesce(a.popularity, 0) desc
  limit greatest(match_count, 1);
$$;

grant execute on function public.match_artists_by_embedding(vector, int, bigint[], text[])
  to authenticated, service_role;
