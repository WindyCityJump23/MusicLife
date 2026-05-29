-- Data API grants for the 9+ Radio cache, learning, and observability schema.
-- Supabase may not auto-expose newly created tables to API roles, so keep the
-- grants explicit and idempotent for staging/prod migration runs.

grant select, insert, update, delete on table
  public.station_cache,
  public.station_runs,
  public.recommendation_events,
  public.taste_snapshots
to authenticated, service_role;

grant usage, select on sequence
  public.recommendation_events_id_seq,
  public.taste_snapshots_id_seq
to authenticated, service_role;

grant select, insert, update, delete on table public.user_taste_strategy
to authenticated, service_role;

grant select, insert, update, delete on table public.user_feedback
to authenticated, service_role;

grant execute on function public.match_tracks(vector(1024), int, text[])
to authenticated, service_role;
