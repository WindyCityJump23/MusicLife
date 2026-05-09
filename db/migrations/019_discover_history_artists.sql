-- Track artist IDs alongside track IDs in discover_history so we can enforce
-- artist-level novelty, not just track-level novelty.
--
-- This migration is intentionally self-contained. Some production databases
-- were missing 012_discover_history.sql, so an ALTER-only migration failed
-- with `relation "public.discover_history" does not exist`.

create table if not exists public.discover_history (
  id bigserial primary key,
  user_id uuid not null,
  run_id uuid not null unique,
  prompt text,
  weights jsonb,
  track_ids text[] not null default '{}',
  track_set_hash text not null default '',
  list_signature text not null default '',
  created_at timestamptz not null default now()
);

alter table public.discover_history
  add column if not exists artist_ids bigint[] not null default '{}',
  add column if not exists lane_distribution jsonb not null default '{}';

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'discover_history'
      and column_name = 'artist_ids'
      and data_type = 'ARRAY'
      and udt_name = '_int4'
  ) then
    alter table public.discover_history
      alter column artist_ids type bigint[] using artist_ids::bigint[];
  end if;
end $$;

create index if not exists idx_discover_history_artist_ids
  on public.discover_history using gin (artist_ids);

create index if not exists idx_discover_history_user_created
  on public.discover_history(user_id, created_at desc);

create unique index if not exists idx_discover_history_user_signature
  on public.discover_history(user_id, list_signature);

alter table public.discover_history enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'discover_history'
      and policyname = 'discover_history_select_own'
  ) then
    create policy discover_history_select_own on public.discover_history
      for select using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'discover_history'
      and policyname = 'discover_history_modify_own'
  ) then
    create policy discover_history_modify_own on public.discover_history
      for all using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end $$;
