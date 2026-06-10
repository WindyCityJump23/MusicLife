-- Favorites taste centroid.
--
-- Hearts were previously only an *exclusion* signal (favorited songs are
-- filtered out of future stations). This RPC turns them into a positive
-- ranking signal: the average embedding of the user's most recent favorited
-- tracks, computed entirely in Postgres so no vectors stream over HTTP
-- (same rationale as 017_pgvector_rpcs.sql).
--
-- Returns NULL when the user has no favorites with embedded tracks; the API
-- treats that as "no favorites signal" and ranking degrades gracefully.

create or replace function public.user_favorites_centroid(p_user_id uuid)
returns vector(1024)
language sql stable as $$
  select avg(t.embedding)
  from (
    select f.spotify_track_id
    from public.user_favorites f
    where f.user_id = p_user_id
    order by f.created_at desc
    limit 200
  ) recent
  join public.tracks t on t.spotify_track_id = recent.spotify_track_id
  where t.embedding is not null;
$$;

grant execute on function public.user_favorites_centroid(uuid)
  to authenticated, service_role;
