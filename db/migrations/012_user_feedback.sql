create table if not exists public.user_feedback (
  id bigserial primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  track_id bigint references public.tracks(id) on delete set null,
  artist_id bigint references public.artists(id) on delete set null,
  spotify_track_id text not null,
  feedback smallint not null check (feedback in (-1, 1)),  -- -1 = thumbs down, 1 = thumbs up
  artist_name text,
  track_name text,
  prompt text,           -- the prompt active when feedback was given (for context learning)
  score real,            -- the recommendation score at time of feedback
  source text not null default 'discover',
  created_at timestamptz not null default now()
);

-- One feedback per user per track (latest wins via upsert)
create unique index if not exists idx_user_feedback_dedup
  on public.user_feedback(user_id, spotify_track_id);

create index if not exists idx_user_feedback_user
  on public.user_feedback(user_id, created_at desc);

-- For the ranking engine: quickly find all thumbs-down artist_ids for a user
create index if not exists idx_user_feedback_negative
  on public.user_feedback(user_id, artist_id)
  where feedback = -1;

-- RLS
alter table public.user_feedback enable row level security;

create policy user_feedback_select_own on public.user_feedback
  for select using (auth.uid() = user_id);

create policy user_feedback_modify_own on public.user_feedback
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
