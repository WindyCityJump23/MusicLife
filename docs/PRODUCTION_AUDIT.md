# Production Audit — MusicLife

_Last updated: April 28, 2026_

## What's done

1. **Spotify OAuth with CSRF hardening** ✅
   - Authorization code flow with `state` nonce.
   - Access token refresh via `/api/auth/token` with cookie-based sessions.
   - Scopes: library read/modify, playback, playlists, streaming.

2. **Library ingestion persists** ✅
   - `spotify_ingest.py` upserts artists, tracks, user_tracks, and listen_events.
   - Idempotent: `ON CONFLICT` with dedupe constraints on listen_events and mentions.

3. **Artist enrichment + embedding pipeline** ✅
   - MusicBrainz + Last.fm enrichment builds `embedding_source` text per artist.
   - Voyage AI (or OpenAI) generates 1024-dim embeddings.
   - Auto-loops all un-embedded artists in one job run (batch size 64).

4. **Editorial source ingestion** ✅
   - RSS + Reddit feeds → extract artist mentions → embed excerpts → upsert into `mentions`.

5. **Three-signal recommendation engine** ✅
   - Affinity (cosine similarity to user taste vector).
   - Context (prompt/taste vector vs. mention embeddings).
   - Editorial (recency × trust × sentiment from mentions).
   - Random exploration ±8%, genre diversity re-ranking, "already seen" deprioritization.

6. **Song-level Discover** ✅
   - Client-side hybrid: backend returns scored artists → browser fetches Spotify top tracks.
   - Songs ranked by `artist_score × track_popularity_boost`.
   - Max 2 songs per artist, deduplication, 30-song limit.

7. **Playlists tab** ✅
   - Create Spotify playlists from recommendations (direct track ID approach).
   - View all MusicLife playlists with expandable track lists.

8. **Favorites** ✅
   - Heart button saves to Spotify Liked Songs + records in `user_favorites` table.
   - Toggle on/off. Tracks source surface (discover, playlists) and score at favorite time.

9. **Web Playback SDK** ✅
   - Jukebox player with album art, progress, volume, prev/next.
   - `playTrack()` plays specific songs by Spotify track ID.

10. **Multi-user support** ✅
    - Each Spotify account gets a unique Supabase user row.
    - Session cookies (`app_user_id`, `sp_access`, `sp_refresh`) scoped per user.
    - Spotify app in Development Mode (25-user allowlist cap until Quota Extension approved).

11. **CORS locked to env allowlist** ✅

12. **RLS policies defined** ✅ (but see Known Security Posture below)

## What's outstanding

### High priority

- **Render cold starts**: Free-tier Render spins down after inactivity. First request after idle takes 30-60s. Upgrade to paid tier or add a keep-alive ping.

- **Embedding provider keys**: Voyage AI or OpenAI key must be configured on Render for the embed pipeline to work. If missing, the embed job fails silently.

- **Anthropic key for /synthesize**: The "Why this?" AI explanation feature requires an Anthropic API key. Not yet provided.

### Medium priority

- **No retry/backoff in ingestion**: Spotify, MusicBrainz, and Last.fm calls have no retry logic. Transient 429s or 5xx errors skip the item silently.

- **Job tracker is in-memory**: `job_tracker.py` uses a Python dict. Jobs are lost on Render restart. Consider a `job_runs` table in Supabase.

- **Ranking thresholds are uncalibrated**: The 0.55/0.45 thresholds for reason tags ("Matches your taste", "In the press") are hardcoded, not tuned on real engagement data.

- **No offline eval loop**: No A/B testing, no click-through tracking (except favorites), no weight tuning pipeline.

### Low priority

- **Vector index tuning**: IVFFlat indexes exist but `lists` and `probes` are at defaults. ANALYZE cadence not specified.

- **Two-stage retrieval**: Current approach scores all candidates in Python. At scale (>10K artists), switch to ANN candidate generation in Postgres + re-rank top N.

## Deployment

| Service | Platform | Auto-deploy | URL |
|---------|----------|------------|-----|
| Frontend | Vercel | Yes (on push) | music-life-kappa.vercel.app |
| Backend API | Render | Sometimes (manual trigger safer) | musiclife-api.onrender.com |
| Database | Supabase | N/A | snylagqoqfkboyuydfgu.supabase.co |

## Migrations

| # | File | Status | Notes |
|---|------|--------|-------|
| 001 | init.sql | Applied | Core schema |
| 002 | playlists.sql | Applied | Playlists + playlist_items |
| 003 | rls.sql | Applied | RLS policies (see security note) |
| 004 | ingest_constraints.sql | Applied | Dedupe keys |
| 005 | mentions_dedup.sql | Applied | Mentions unique constraint |
| 006 | triggers_and_indexes.sql | Applied | Additional indexes |
| 007 | users_display_name.sql | Applied | display_name column |
| 008 | track_audio_features.sql | Deprecated | Spotify deprecated /audio-features Nov 2024. Columns exist but are never populated. |
| 009 | user_favorites.sql | Applied | Favorites tracking |
