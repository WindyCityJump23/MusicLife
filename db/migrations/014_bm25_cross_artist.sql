-- Widen the candidate pool: let search_tracks_bm25 run unrestricted
-- across the full track catalog when artist_ids is null, and return
-- artist_id alongside track_id so callers can union the matched
-- artists into the recommendation candidate pool.
--
-- The previous signature is preserved (callers passing artist_ids
-- continue to work) — only the return shape changes (added artist_id
-- column) and a new max_results cap is introduced.

drop function if exists public.search_tracks_bm25(text, bigint[]);

create or replace function public.search_tracks_bm25(
  q text,
  artist_ids bigint[] default null,
  max_results int default 200
) returns table(track_id bigint, artist_id bigint, rank real)
language sql
stable
as $$
  with tsq as (
    select websearch_to_tsquery('english', coalesce(q, '')) as query
  )
  select t.id as track_id,
         t.artist_id,
         ts_rank_cd(t.search_tsv, tsq.query) as rank
    from public.tracks t, tsq
   where tsq.query <> ''::tsquery
     and t.search_tsv @@ tsq.query
     and (artist_ids is null or t.artist_id = any(artist_ids))
   order by rank desc
   limit greatest(max_results, 1)
$$;

grant execute on function public.search_tracks_bm25(text, bigint[], int) to anon, authenticated, service_role;
