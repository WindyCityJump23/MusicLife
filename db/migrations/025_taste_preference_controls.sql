-- Human-readable Taste Profile controls.

alter table public.user_taste_strategy
  add column if not exists station_distance text not null default 'balanced'
    check (station_distance in ('closer', 'balanced', 'further')),
  add column if not exists familiarity text not null default 'balanced'
    check (familiarity in ('anchors', 'balanced', 'surprises'));

