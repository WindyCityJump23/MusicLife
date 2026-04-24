-- Enable and enforce RLS for user-owned data.
-- Service-role requests bypass RLS and remain available for trusted jobs.

alter table public.users enable row level security;
alter table public.user_tracks enable row level security;
alter table public.listen_events enable row level security;
alter table public.playlists enable row level security;
alter table public.playlist_items enable row level security;

-- Core user identity row
create policy users_select_own on public.users
  for select using (auth.uid() = id);

create policy users_update_own on public.users
  for update using (auth.uid() = id)
  with check (auth.uid() = id);

-- User-library state
create policy user_tracks_select_own on public.user_tracks
  for select using (auth.uid() = user_id);

create policy user_tracks_modify_own on public.user_tracks
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy listen_events_select_own on public.listen_events
  for select using (auth.uid() = user_id);

create policy listen_events_insert_own on public.listen_events
  for insert with check (auth.uid() = user_id);

-- Playlists and items
create policy playlists_select_own on public.playlists
  for select using (auth.uid() = user_id);

create policy playlists_modify_own on public.playlists
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy playlist_items_select_own on public.playlist_items
  for select using (
    exists (
      select 1 from public.playlists p
      where p.id = playlist_id and p.user_id = auth.uid()
    )
  );

create policy playlist_items_modify_own on public.playlist_items
  for all using (
    exists (
      select 1 from public.playlists p
      where p.id = playlist_id and p.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.playlists p
      where p.id = playlist_id and p.user_id = auth.uid()
    )
  );

-- Shared/catalog data (read-only to authenticated users)
alter table public.artists enable row level security;
alter table public.tracks enable row level security;
alter table public.sources enable row level security;
alter table public.mentions enable row level security;

create policy artists_read_authenticated on public.artists
  for select using (auth.role() = 'authenticated');

create policy tracks_read_authenticated on public.tracks
  for select using (auth.role() = 'authenticated');

create policy sources_read_authenticated on public.sources
  for select using (auth.role() = 'authenticated');

create policy mentions_read_authenticated on public.mentions
  for select using (auth.role() = 'authenticated');
