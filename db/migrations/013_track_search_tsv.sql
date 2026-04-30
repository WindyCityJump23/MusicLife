-- Hybrid BM25 + vector re-rank: full-text search index over track text.
--
-- The vector context score handles semantic matches ("rainy night"
-- → "melancholic ballad") but cosine similarity can wash out literal
-- matches: searches for "Bohemian Rhapsody" or "songs about rain"
-- compete against semantically-similar but textually-unrelated tracks.
-- A tsvector + ts_rank_cd score restores literal phrase weight.
--
-- The tsvector is GENERATED from tracks.embedding_source, so the
-- track_tag_backfill that already maintains embedding_source ("artist
-- – title – album | tags: a, b, c") keeps the index fresh for free.

create extension if not exists pg_trgm;

alter table public.tracks
  add column if not exists search_tsv tsvector
    generated always as (
      to_tsvector('english', coalesce(embedding_source, ''))
    ) stored;

create index if not exists idx_tracks_search_tsv
  on public.tracks using gin (search_tsv);

-- Trigram index on track name so we can fall back to fuzzy title match
-- (typos, partial matches) when websearch_to_tsquery returns nothing.
create index if not exists idx_tracks_name_trgm
  on public.tracks using gin (name gin_trgm_ops);


-- BM25-style scoring RPC. Takes a free-text query and a pool of
-- artist ids; returns matching track ids with a relevance rank in
-- (0, 1] range (clamped). Caller normalizes by the per-batch max
-- before blending into the recommendation score.
--
-- Uses websearch_to_tsquery so users can pass natural prompts like
-- ``rainy night drive`` or ``"summer of love"`` without crafting a
-- tsquery by hand.

create or replace function public.search_tracks_bm25(
  q text,
  artist_ids bigint[]
) returns table(track_id bigint, rank real)
language sql
stable
as $$
  with tsq as (
    select websearch_to_tsquery('english', coalesce(q, '')) as query
  )
  select t.id as track_id,
         ts_rank_cd(t.search_tsv, tsq.query) as rank
    from public.tracks t, tsq
   where artist_ids is not null
     and t.artist_id = any(artist_ids)
     and tsq.query <> ''::tsquery
     and t.search_tsv @@ tsq.query
$$;

grant execute on function public.search_tracks_bm25(text, bigint[]) to anon, authenticated, service_role;
