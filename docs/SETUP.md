# Setup

## 1) Prerequisites

- Node.js 20+
- Python 3.11+
- Supabase project with `pgvector` enabled
- Spotify app credentials

## 2) Environment files

Copy templates:

- `web/.env.example` -> `web/.env.local`
- `api/.env.example` -> `api/.env`

Fill required values:

### Web

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SPOTIFY_CLIENT_ID`
- `SPOTIFY_CLIENT_SECRET`
- `SPOTIFY_REDIRECT_URI` (for local dev: `http://localhost:3000/api/auth/callback`)

### API

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ANTHROPIC_API_KEY`
- `VOYAGE_API_KEY` and/or `OPENAI_API_KEY`
- `EMBEDDING_PROVIDER` (`voyage` or `openai`)
- `EMBEDDING_MODEL`
- `EMBEDDING_DIMS`
- `LASTFM_API_KEY`
- `MUSICBRAINZ_USER_AGENT`

## 3) Database bootstrap

Run SQL in order:

1. `db/migrations/001_init.sql`
2. `db/migrations/002_playlists.sql`
3. `db/seed/sources.sql`

## 4) Run API

```bash
cd api
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

## 5) Run web

```bash
cd web
npm install
npm run dev
```

## 6) Smoke checks

- Open `http://localhost:3000` and complete Spotify login.
- Verify API health: `GET http://localhost:8000/health`.
- Queue Spotify ingestion via `POST /ingest/spotify-library`.
