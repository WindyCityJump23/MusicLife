-- Unique constraint enabling idempotent re-ingestion of listen events.
-- ON CONFLICT (user_id, track_id, listened_at) DO NOTHING in spotify_ingest.py
-- relies on this constraint being present.
alter table public.listen_events
  add constraint listen_events_dedup_key
  unique (user_id, track_id, listened_at);

-- Indexes flagged as missing in the production audit.
create index if not exists idx_listen_events_user
  on public.listen_events(user_id, listened_at desc);

create index if not exists idx_mentions_source_date
  on public.mentions(source_id, published_at desc);
