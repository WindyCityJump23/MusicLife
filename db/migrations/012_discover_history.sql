create table if not exists public.discover_history (
  id bigserial primary key,
  user_id uuid not null,
  run_id uuid not null unique,
  prompt text,
  weights jsonb,
  track_ids text[] not null,
  track_set_hash text not null,
  list_signature text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_discover_history_user_created
  on public.discover_history(user_id, created_at desc);

create unique index if not exists idx_discover_history_user_signature
  on public.discover_history(user_id, list_signature);

alter table public.discover_history enable row level security;

create policy discover_history_select_own on public.discover_history
  for select using (auth.uid() = user_id);

create policy discover_history_modify_own on public.discover_history
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
