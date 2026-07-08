-- Pipeline deepening: per-track Last.fm tags + Deezer charts source.
--
-- 1) tracks.lastfm_tags: track-level mood/style tags from Last.fm
--    (track.getTopTags). Folded into tracks.embedding_source so track
--    embeddings carry song-level semantics — prompt matching previously
--    leaned almost entirely on artist-level context. Empty array means
--    "looked up, none found" (marks the row visited); NULL means not yet
--    fetched, which keeps the backfill resumable.
--
-- 2) A 'deezer_chart' source row: the Deezer global chart (free, no auth)
--    ingested as editorial mentions. Charting tracks are genuinely
--    recognizable *current* hits — a signal Spotify's API no longer
--    provides — and unknown charting artists widen the catalog through the
--    existing enrichment pipeline.

alter table public.tracks
  add column if not exists lastfm_tags text[];

comment on column public.tracks.lastfm_tags is
  'Last.fm track.getTopTags tags. [] = looked up but none found; NULL = not yet fetched.';

insert into public.sources (name, kind, url, trust_weight, active)
values ('Deezer Charts', 'deezer_chart', 'https://api.deezer.com/chart/0/tracks', 0.900, true)
on conflict (name) do nothing;
