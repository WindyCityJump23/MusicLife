-- Track artist IDs alongside track IDs in discover_history so we can
-- enforce artist-level novelty (not just track-level).
-- Also add a lane_distribution column so the backend can persist what
-- mix of lanes it served, enabling lane-aware history checks.

alter table public.discover_history
  add column if not exists artist_ids integer[] not null default '{}',
  add column if not exists lane_distribution jsonb not null default '{}';

create index if not exists idx_discover_history_artist_ids
  on public.discover_history using gin (artist_ids);
