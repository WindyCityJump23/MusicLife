-- Add support for playlist-import (guest) users who bypass Spotify OAuth.
-- Guest users have spotify_user_id = NULL and auth_type = 'playlist_import'.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS auth_type text NOT NULL DEFAULT 'spotify',
  ADD COLUMN IF NOT EXISTS playlist_source_url text;

COMMENT ON COLUMN public.users.auth_type IS
  'Authentication tier: "spotify" (full OAuth) or "playlist_import" (guest via public playlist)';
COMMENT ON COLUMN public.users.playlist_source_url IS
  'Last playlist URL imported by a playlist_import user';
