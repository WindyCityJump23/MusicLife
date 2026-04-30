-- Track-level descriptive tags (Last.fm track.getTopTags).
--
-- Last.fm tracks carry user-contributed tags like "chill", "melancholy",
-- "summer", "running music" — strong mood signal that artist genres miss.
-- Storing them lets us include them in tracks.embedding_source so the
-- vector captures the *track's* vibe, not just the artist's.

alter table public.tracks
  add column if not exists tags text[] not null default '{}';

create index if not exists idx_tracks_tags
  on public.tracks using gin (tags);
