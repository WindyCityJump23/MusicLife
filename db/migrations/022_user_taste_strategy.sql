create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.user_taste_strategy (
  user_id uuid primary key references public.users(id) on delete cascade,
  genre_boosts text[] not null default '{}',
  genre_avoids text[] not null default '{}',
  discovery_mix jsonb not null default '{"deep_cuts": 38, "popular": 38, "radio_hits": 24}'::jsonb,
  live_expansion text not null default 'auto' check (live_expansion in ('auto', 'catalog', 'live')),
  freshness text not null default 'balanced' check (freshness in ('newer', 'balanced', 'timeless')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_user_taste_strategy_updated
  on public.user_taste_strategy(updated_at desc);

drop trigger if exists user_taste_strategy_set_updated_at on public.user_taste_strategy;
create trigger user_taste_strategy_set_updated_at
  before update on public.user_taste_strategy
  for each row execute procedure public.set_updated_at();

alter table public.user_taste_strategy enable row level security;

create policy user_taste_strategy_select_own on public.user_taste_strategy
  for select using (auth.uid() = user_id);

create policy user_taste_strategy_insert_own on public.user_taste_strategy
  for insert with check (auth.uid() = user_id);

create policy user_taste_strategy_update_own on public.user_taste_strategy
  for update using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy user_taste_strategy_delete_own on public.user_taste_strategy
  for delete using (auth.uid() = user_id);

grant select, insert, update, delete on public.user_taste_strategy to authenticated;
