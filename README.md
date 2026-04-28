# MusicLife

A personal music discovery dashboard powered by Spotify, editorial sources (music blogs, Reddit, Bandcamp), and AI recommendations.

**Stack:** Next.js 14 · FastAPI · Supabase (Postgres + pgvector) · Anthropic Claude · Voyage AI

---

## What it does

- Syncs your Spotify library, top artists, and recent plays
- Enriches artists with MusicBrainz + Last.fm metadata
- Embeds artist profiles as vectors for taste-aware similarity
- Crawls editorial RSS feeds and Reddit to find mention heat
- Recommends artists you haven't heard yet, blending personal affinity, prompt context, and editorial momentum
- Lets you save, name, and revisit discovery views

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
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) |
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

Or paste each file manually in **Supabase → SQL Editor**:

1. `db/migrations/001_init.sql`
2. `db/migrations/002_playlists.sql`
3. `db/migrations/003_rls.sql`
4. `db/migrations/004_ingest_constraints.sql`
5. `db/migrations/005_mentions_dedup.sql`
6. `db/migrations/006_triggers_and_indexes.sql`
7. `db/seed/sources.sql`

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

### 6. Populate your library

In the dashboard sidebar (bottom section):

1. **Sync Spotify library** — imports your saved tracks, top artists, and recent plays
2. **Enrich artists** — fetches MusicBrainz + Last.fm metadata and bios (takes a few minutes; runs 1 req/s to respect MusicBrainz rate limits)
3. **Embed artists** — generates taste vectors (requires Voyage or OpenAI key)
4. **Fetch sources** — crawls editorial RSS feeds for mention heat

Once all four steps are complete, the **Discover** tab will return real recommendations.

---

## Architecture

```
web/          Next.js 14 frontend (App Router, Tailwind, Spotify SDK)
api/          FastAPI ingestion + ranking + synthesis service
db/           SQL migrations and seed data
docs/         Design notes, architecture decisions, API references
```

Three-signal recommendation model:

```
score = w_affinity * affinity + w_context * context + w_editorial * editorial
```

- **Affinity** — cosine similarity between candidate artist embedding and your taste centroid
- **Context** — cosine similarity between your prompt embedding and editorial mention embeddings
- **Editorial** — recency × trust weight × sentiment from crawled sources

Weights are controlled by the sliders in the Discover view.

---

## API reference

Full interactive docs at [http://localhost:8000/docs](http://localhost:8000/docs) once the API is running.

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Liveness + DB connectivity check |
| `POST /ingest/spotify-library` | Pull Spotify library and listens |
| `POST /ingest/enrich-artists` | MusicBrainz + Last.fm enrichment |
| `POST /ingest/embed-artists` | Generate artist embeddings |
| `POST /ingest/sources` | Crawl RSS + Reddit feeds |
| `POST /recommend` | Get taste-aware recommendations |
| `POST /synthesize/for-artist` | Generate "Why this?" explanation via Claude |

---

## Docs

- [`docs/SETUP.md`](docs/SETUP.md) — detailed setup with every API key
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — design decisions
- [`docs/PRODUCTION_AUDIT.md`](docs/PRODUCTION_AUDIT.md) — known issues and roadmap
- [`docs/SOURCES.md`](docs/SOURCES.md) — editorial source list
