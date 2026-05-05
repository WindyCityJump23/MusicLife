-- pgvector RPCs to push cosine-similarity work into Postgres.
--
-- Until now, ranking.py and song_ranking.py pulled every artists.embedding
-- (vector(1024)) and mentions.embedding row over HTTPS to compute similarity
-- in Python. Each vector serializes to ~10 KB of JSON, so a request streamed
-- 20+ MB from PostgREST to the Render backend on every Discover click.
-- That payload regularly exceeded the connection's read window and surfaced
-- as `httpx.RemoteProtocolError: Server disconnected` → 25s Vercel 504s.
--
-- These functions push the heavy work into Postgres (where pgvector's
-- IVFFlat index makes it fast) and return only the small metadata + score
-- the API actually needs.

-- ── Artist pool (similarity / popularity / genre-filtered) ────────
-- One RPC that covers every "give me the candidate artists" path the
-- ranker needs:
--   • query_embedding non-null: order by cosine distance to that vector
--     and return the cosine similarity in [-1, 1] for each row.
--   • query_embedding null: fall back to popularity ordering, similarity=0.
--   • exclude_ids: drop these artist IDs (used when exclude_library=true).
--   • genre_tokens non-null/empty: keep only artists whose genres array
--     fuzzy-matches any token (used when the prompt looks like a genre).
-- All matches require artists.embedding IS NOT NULL because the rest of
-- the ranker needs an embedding-bearing pool.
create or replace function public.match_artists_by_embedding(
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
  similarity real
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
    end as similarity
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

-- ── Per-artist max mention similarity ──────────────────────────────
-- For the "context" signal: each artist's editorial coverage may have
-- many mentions; we want the single best cosine match between the query
-- vector and any of that artist's mention embeddings. Done in SQL so
-- mention.embedding never crosses the wire.
create or replace function public.max_mention_similarity_per_artist(
  query_embedding vector(1024),
  artist_ids bigint[]
)
returns table(
  artist_id bigint,
  max_similarity real
)
language sql stable as $$
  select
    m.artist_id,
    max(1 - (m.embedding <=> query_embedding))::real as max_similarity
  from public.mentions m
  where m.artist_id = any(artist_ids)
    and m.embedding is not null
  group by m.artist_id;
$$;

grant execute on function public.max_mention_similarity_per_artist(vector, bigint[])
  to authenticated, service_role;

-- ── Track similarity by query vector ───────────────────────────────
-- Used by song_ranking.py to score per-track context (cosine of prompt
-- vs track.embedding) and per-track affinity (cosine of taste vs
-- track.embedding) without pulling every track's vector(1024).
create or replace function public.track_similarity_for_artists(
  query_embedding vector(1024),
  artist_ids bigint[]
)
returns table(
  track_id bigint,
  similarity real
)
language sql stable as $$
  select
    t.id as track_id,
    (1 - (t.embedding <=> query_embedding))::real as similarity
  from public.tracks t
  where t.artist_id = any(artist_ids)
    and t.embedding is not null;
$$;

grant execute on function public.track_similarity_for_artists(vector, bigint[])
  to authenticated, service_role;

-- The taste-centroid build still happens in Python because it only
-- pulls embeddings for the user's library artists (~hundreds, bounded
-- and small enough). The catastrophic payload was always the catalog-
-- wide candidate fetch — that's what these RPCs eliminate.
