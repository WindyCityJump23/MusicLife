-- Migration 006: auto-update updated_at on playlists, plus missing performance indexes.

-- ============================================================
-- updated_at trigger for playlists
-- ============================================================
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists playlists_set_updated_at on public.playlists;
create trigger playlists_set_updated_at
  before update on public.playlists
  for each row execute procedure public.set_updated_at();

-- Same trigger for artists (embedding jobs update the row but don't touch updated_at).
drop trigger if exists artists_set_updated_at on public.artists;
create trigger artists_set_updated_at
  before update on public.artists
  for each row execute procedure public.set_updated_at();

-- ============================================================
-- Missing indexes flagged in the production audit
-- ============================================================

-- Fast playlist lookups by user, ordered by most-recently-modified.
create index if not exists idx_playlists_user_updated
  on public.playlists(user_id, updated_at desc);

-- artist_embeddings job: quick scan for rows needing embeddings.
create index if not exists idx_artists_needs_embedding
  on public.artists(id)
  where embedding_source is not null and embedding is null;

-- artist_enrichment job: quick scan for unenriched rows.
create index if not exists idx_artists_needs_enrichment
  on public.artists(id)
  where musicbrainz_id is null and lastfm_url is null;

-- playlist_items ordered retrieval.
create index if not exists idx_playlist_items_playlist
  on public.playlist_items(playlist_id, rank asc nulls last);
