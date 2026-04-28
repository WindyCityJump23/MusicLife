# Setup

> **Quickstart:** See the main `README.md` for the fastest path. This doc covers every detail.

## 1) Prerequisites

- Node.js 20+
- Python 3.11+
- Supabase project with `pgvector` enabled (free tier works)
- Spotify Developer app

## 2) Environment files

```bash
make env   # scaffolds both env files from their examples
```

Or copy manually:

```bash
cp web/.env.local.example web/.env.local
cp api/.env.example api/.env
```

Fill required values:

### Web (`web/.env.local`)

| Variable | Notes |
|----------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side only — never exposed to browser |
| `SPOTIFY_CLIENT_ID` | Spotify Developer Dashboard |
| `SPOTIFY_CLIENT_SECRET` | Spotify Developer Dashboard |
| `SPOTIFY_REDIRECT_URI` | `http://localhost:3000/api/auth/callback` for local dev |
| `NEXT_PUBLIC_API_URL` | `http://localhost:8000` |
| `TEST_USER_ID` | Your Supabase user UUID (get after first login, see below) |

### API (`api/.env`)

| Variable | Notes |
|----------|-------|
| `SUPABASE_URL` | Same project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Same key |
| `SUPABASE_ANON_KEY` | Supabase anon/public key |
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `VOYAGE_API_KEY` | dash.voyageai.com (if using Voyage) |
| `OPENAI_API_KEY` | platform.openai.com (if using OpenAI) |
| `EMBEDDING_PROVIDER` | `voyage` or `openai` |
| `EMBEDDING_MODEL` | `voyage-3` or `text-embedding-3-large` |
| `EMBEDDING_DIMS` | `1024` (Voyage) or `3072` (OpenAI — requires schema change) |
| `LASTFM_API_KEY` | last.fm/api/account/create |
| `MUSICBRAINZ_USER_AGENT` | `yourapp/1.0 (your@email.com)` |
| `CORS_ORIGINS` | `http://localhost:3000` |

## 3) Spotify app setup

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. Create or open your app
3. Add Redirect URI: `http://localhost:3000/api/auth/callback`
4. For production, also add your production URL
5. Your app needs Spotify Premium for Web Playback SDK

## 4) Database bootstrap

Run SQL files in order. Either paste into **Supabase → SQL Editor** or use psql:

```bash
export DATABASE_URL=postgres://postgres:[password]@[host]:5432/postgres
make migrate
```

Manual order:

1. `db/migrations/001_init.sql` — core schema + pgvector indexes
2. `db/migrations/002_playlists.sql` — saved views / playlists
3. `db/migrations/003_rls.sql` — Row Level Security policies
4. `db/migrations/004_ingest_constraints.sql` — dedup indexes for listen events
5. `db/migrations/005_mentions_dedup.sql` — dedup indexes for editorial mentions
6. `db/migrations/006_triggers_and_indexes.sql` — updated_at triggers + perf indexes
7. `db/seed/sources.sql` — seed editorial sources (RA, Pitchfork, Stereogum, etc.)

## 5) Run locally

```bash
make dev         # installs deps + starts both services
```

Or separately:

```bash
make api         # FastAPI on :8000
make web         # Next.js on :3000
```

- Web: http://localhost:3000
- API docs: http://localhost:8000/docs
- Health check: http://localhost:8000/health

## 6) Get your TEST_USER_ID

After running both services:

1. Open http://localhost:3000
2. Click **Connect Spotify** — completes OAuth and creates your user row
3. Go to **Supabase → Authentication → Users**
4. Copy your UUID
5. Set `TEST_USER_ID=<uuid>` in `web/.env.local`
6. Restart web: `make web`

## 7) Smoke checks

```bash
# API health (should show db: true)
curl http://localhost:8000/health

# Spotify OAuth
open http://localhost:3000   # click Connect Spotify

# After login, trigger a library sync from the dashboard sidebar
```

## 8) Ingest pipeline order

Run in this order from the dashboard sidebar:

1. **Sync Spotify library** — artists, tracks, listen events
2. **Enrich artists** — MusicBrainz IDs + Last.fm bios/tags (runs at 1 req/s, takes a few minutes)
3. **Embed artists** — generates taste vectors (requires embedding API key)
4. **Fetch sources** — crawls RSS/Reddit for editorial mentions

After all four, the **Discover** tab will return real results.

## Embedding dimension note

The schema fixes `vector(1024)` — this matches Voyage AI's `voyage-3` model.

If using OpenAI `text-embedding-3-large`, you must request `dimensions=1024` explicitly in your API call, or update the schema to `vector(3072)` and re-run `001_init.sql` (drop and recreate the table if already populated).
