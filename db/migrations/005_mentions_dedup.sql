-- Idempotent re-ingestion for editorial mentions.
-- ON CONFLICT (source_id, url, artist_id) DO NOTHING in source_ingest.py
-- relies on this constraint being present.
--
-- url is part of the key because a single source post can mention multiple
-- artists; one mention row per (post, artist) is what we want.
alter table public.mentions
  add constraint mentions_dedup_key
  unique (source_id, url, artist_id);

-- Backfill index suggested in the production audit for activity-feed queries
-- ordered by recency.
create index if not exists idx_mentions_published
  on public.mentions(published_at desc);
