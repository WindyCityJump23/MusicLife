# MusicLife

Pandora-style personal radio with playlist export and daily editorial discovery refresh.

**Stack:** Next.js 14 · FastAPI · Supabase (Postgres + pgvector) · Voyage AI · Spotify Web Playback SDK

---

## What it does

- **Personal radio:** Syncs your Spotify library, builds a taste profile from your listening history, and generates personalized song recommendations you can play in-browser
- **Discovery engine:** Blends personal taste affinity, editorial momentum from music blogs/Reddit, and prompt context to surface music you wouldn't find yourself
- **Lane-aware results:** Backend enforces quotas across three lanes — deep cuts (45%), popular picks (35%), and familiar comfort (20%) — so every session has genuine discoveries
- **Novelty guardrails:** Tracks discovery history at both track and artist level, ensuring you don't get the same recommendations twice
- **Editorial ingest:** Crawls RSS feeds and Reddit for artist mentions, and creates new artist candidates from blog-sourced tracks to expand the discovery universe
- **Playlist export:** Save any Discover session as a Spotify playlist with one click
- **Playback:** Built-in Spotify Web Playback SDK player with queue management

---

## Quickstart (local dev)

### Option A — Docker (easiest, no installs needed)

Requires: [Docker Desktop](https://www.docker.com/products/docker-desktop/)

```bash
git clone https://github.com/WindyCityJump23/MusicLife.git
cd MusicLife
./setup.sh          # scaffolds env files and prints instructions

# fill in web/.env.local and api/.env, run DB migrations, then:
docker compose up
```

Open [http://localhost:3000](http://localhost:3000) — that's it.

---

### Option B — Manual (no Docker)

#### Prerequisites

| Tool | Version |
|------|---------|
| Node.js | 20+ |
| Python | 3.11+ |
| Supabase project | with `pgvector` enabled |

#### Clone and scaffold env files

```bash
git clone https://github.com/WindyCityJump23/MusicLife.git
cd MusicLife
make env        # copies .env.local.example → web/.env.local and api/.env.example → api/.env
```

### 3. Fill in your environment variables

#### `web/.env.local`

| Variable | Where to get it |
|----------|----------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API (keep server-side only) |
| `SPOTIFY_CLIENT_ID` | [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) |
| `SPOTIFY_CLIENT_SECRET` | Spotify Developer Dashboard |
| `SPOTIFY_REDIRECT_URI` | `http://localhost:3000/api/auth/callback` |
| `NEXT_PUBLIC_API_URL` | `http://localhost:8000` |

#### `api/.env`

| Variable | Where to get it |
|----------|----------------|
| `SUPABASE_URL` | Same as above |
| `SUPABASE_SERVICE_ROLE_KEY` | Same as above |
| `SUPABASE_ANON_KEY` | Same as above |
| `VOYAGE_API_KEY` | [dash.voyageai.com](https://dash.voyageai.com) *(or use OpenAI below)* |
| `EMBEDDING_PROVIDER` | `voyage` or `openai` |
| `EMBEDDING_MODEL` | `voyage-3` *(Voyage)* or `text-embedding-3-large` *(OpenAI)* |
| `EMBEDDING_DIMS` | `1024` *(Voyage)* or `3072` *(OpenAI — requires schema change)* |
| `LASTFM_API_KEY` | [last.fm/api](https://www.last.fm/api/account/create) |
| `MUSICBRAINZ_USER_AGENT` | `appname/1.0 (your@email.com)` |
| `CORS_ORIGINS` | `http://localhost:3000` |

> **Spotify app setup:** In the Spotify Developer Dashboard, add `http://localhost:3000/api/auth/callback` to your app's Redirect URIs.

### 4. Run database migrations

Run all migrations in order in the Supabase SQL editor, or via psql:

```bash
# Via psql (get the connection string from Supabase → Project Settings → Database)
export DATABASE_URL=postgres://postgres:[password]@[host]:5432/postgres
make migrate
```

Or paste each file in **Supabase → SQL Editor** in order (`db/migrations/001_init.sql` through `017_discover_history_artists.sql`), then seed data with `db/seed/sources.sql`.

### 5. Install dependencies and start

```bash
make dev
```

This installs all Python and Node deps and starts both services:
- **Web** → [http://localhost:3000](http://localhost:3000)
- **API** → [http://localhost:8000](http://localhost:8000)
- **API docs** → [http://localhost:8000/docs](http://localhost:8000/docs)

Or start them separately:

```bash
make api   # FastAPI only
make web   # Next.js only
```

### 6. Set up your radio

In the dashboard sidebar:

1. **Sync Library** — imports your saved tracks, top artists, and recent plays
2. **Enrich Artists** — fetches MusicBrainz + Last.fm metadata (runs at 1 req/s)
3. **Generate Embeddings** — creates taste vectors (requires Voyage or OpenAI key)
4. **Populate Tracks** — builds the track catalog for song-level recommendations
5. **Refresh Sources** — crawls editorial feeds for mention heat and new artist candidates

Once all steps are complete, the **Discover** tab generates personalized radio sessions.

---

## Architecture

```
web/          Next.js 14 frontend (App Router, Tailwind, Spotify Web Playback SDK)
api/          FastAPI ranking + ingestion + discovery service
db/           SQL migrations and seed data
```

### Recommendation model

```
song_score = (w_affinity × track_affinity + w_context × track_context + w_editorial × editorial) × track_boost
```

- **Affinity** — cosine(taste_vector, track/artist embedding), blended with genre preference weights
- **Context** — cosine(prompt_embedding, track/mention embedding), with prompt classification (genre vs mood vs semantic)
- **Editorial** — recency × trust_weight × sentiment from crawled sources
- **Track boost** — popularity, recency, audio feature alignment, familiarity penalty, obscurity bonus, feedback

### Discovery pipeline

1. **Prompt classifier** distinguishes genre queries ("alternative rock") from mood queries ("sad night drive") from semantic queries ("new Chicago indie") — genre queries filter the artist pool, mood/semantic queries rely on embedding similarity
2. **Lane assignment** happens in the backend: each track is assigned to `deep_cut`, `popular`, or `familiar` based on popularity, library overlap, and editorial signal
3. **Lane quotas** enforce a mix (45% deep cuts, 35% popular, 20% familiar) during diversity reranking
4. **Novelty tracking** persists both track IDs and artist IDs per discover run; subsequent requests exclude recently shown artists (not just tracks)
5. **Editorial ingest** creates new artist records from blog-sourced tracks, expanding the catalog beyond the user's existing library

### Key endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Liveness + readiness check |
| `POST /recommend` | Artist-level taste recommendations |
| `POST /recommend/songs` | Song-level recommendations with lanes, novelty, and history |
| `POST /ingest/spotify-library` | Pull Spotify library and listens |
| `POST /ingest/enrich-artists` | MusicBrainz + Last.fm enrichment |
| `POST /ingest/embed-artists` | Generate artist embeddings |
| `POST /ingest/sources` | Crawl RSS + Reddit feeds, create new artists |
| `POST /playlist-from-tracks` | Export discover session to Spotify playlist |

---

## Docs

- [`docs/SETUP.md`](docs/SETUP.md) — detailed setup with every API key
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — design decisions
- [`docs/PRODUCTION_AUDIT.md`](docs/PRODUCTION_AUDIT.md) — known issues and roadmap
- [`docs/SOURCES.md`](docs/SOURCES.md) — editorial source list
