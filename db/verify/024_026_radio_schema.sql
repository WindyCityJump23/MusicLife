-- Verifies the 9+ Radio/Taste schema expected by migrations 024-026.
-- Run with psql after applying migrations:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/verify/024_026_radio_schema.sql

do $$
declare
  missing text[] := '{}';
begin
  if to_regclass('public.station_cache') is null then
    missing := missing || 'table public.station_cache';
  end if;
  if to_regclass('public.station_runs') is null then
    missing := missing || 'table public.station_runs';
  end if;
  if to_regclass('public.recommendation_events') is null then
    missing := missing || 'table public.recommendation_events';
  end if;
  if to_regclass('public.taste_snapshots') is null then
    missing := missing || 'table public.taste_snapshots';
  end if;
  if to_regprocedure('public.match_tracks(vector, integer, text[])') is null then
    missing := missing || 'function public.match_tracks(vector, integer, text[])';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'user_feedback'
      and column_name = 'reason'
  ) then
    missing := missing || 'column public.user_feedback.reason';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'user_taste_strategy'
      and column_name = 'station_distance'
  ) then
    missing := missing || 'column public.user_taste_strategy.station_distance';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'user_taste_strategy'
      and column_name = 'familiarity'
  ) then
    missing := missing || 'column public.user_taste_strategy.familiarity';
  end if;

  if array_length(missing, 1) is not null then
    raise exception 'Missing MusicLife radio schema objects: %', array_to_string(missing, ', ');
  end if;
end $$;

select 'MusicLife radio schema OK' as status;
