create table if not exists public.setup_jobs (
  id uuid primary key,
  user_id uuid references public.users(id) on delete cascade,
  kind text not null,
  status text not null check (status in ('queued', 'running', 'success', 'failed')),
  step int not null default 0,
  total_steps int,
  message text not null default '',
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists idx_setup_jobs_user_created
  on public.setup_jobs(user_id, created_at desc);

create index if not exists idx_setup_jobs_kind_created
  on public.setup_jobs(kind, created_at desc);

alter table public.setup_jobs enable row level security;

create policy setup_jobs_select_own on public.setup_jobs
  for select using (auth.uid() = user_id);
