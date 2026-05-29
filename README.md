# MusicLife

Pandora-style personal radio and playlist discovery powered by Spotify, editorial sources, and vector recommendations.

**Stack:** Next.js 14 · FastAPI · Supabase (Postgres + pgvector) · Voyage AI · Spotify Web Playback SDK

---

## What it does

- Syncs your Spotify library, top artists, and recent plays
- Enriches artists with MusicBrainz + Last.fm metadata
- Embeds artist profiles and tracks as vectors for taste-aware similarity
- Crawls editorial RSS feeds and Reddit to find daily music buzz
- Expands the catalog from blog-sourced tracks, not just artists already in your library
- Builds radio-style song queues across three lanes: radio hits, popular cuts, and deep cuts / indie
- Uses novelty guardrails so recently shown tracks and artists do not dominate repeat sessions
- Lets you play recommendations in the browser or save the full queue as a Spotify playlist

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

Or paste each file in **Supabase → SQL Editor** in filename order (`db/migrations/001_init.sql` through the latest migration), then seed data with `db/seed/sources.sql`.

For an existing project that already has migrations `001`-`023`, apply and verify the Radio/Taste upgrade only:

```bash
export DATABASE_URL=postgres://postgres:[password]@[host]:5432/postgres
make migrate-radio
```

Production should also pass `GET /api/radio-health/schema`; it reports whether the station cache, station runs, recommendation events, taste snapshots, taste controls, and `match_tracks` RPC are active in Supabase.

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

### 6. Build your Music Profile

In the dashboard sidebar, run **Refresh music profile** once:

1. **Import listening history** — imports Spotify saved tracks, top artists, and recent plays
2. **Learn your taste** — fetches MusicBrainz + Last.fm metadata and genres
3. **Build your radio model** — embeds artist profiles as taste vectors
4. **Add music context** — crawls editorial RSS/Reddit sources for mention heat and blog-sourced tracks
5. **Prepare song catalog** — loads playable Spotify tracks for radio and playlist export
6. **Model songs** — embeds track context so song-level lanes and prompts have fresher signals

After setup is ready, the **Radio** tab can generate playable recommendations. You do not need to run the full setup every time. Use **Refresh sources** when you want fresh blog/community context; it can run independently and is safe to use daily.

---

## Architecture

```
web/          Next.js 14 frontend (App Router, Tailwind, Spotify Web Playback SDK)
api/          FastAPI ranking + ingestion + discovery service
db/           SQL migrations and seed data
```

Discovery model:

```
base_score = w_affinity * affinity + w_context * context + w_editorial * editorial
song_score = base_score * track_boost * novelty_adjustment
```

- **Affinity** — cosine similarity between candidate artist embedding and your taste centroid
- **Context** — cosine similarity between your prompt embedding and editorial mention embeddings
- **Editorial** — recency × trust weight × sentiment from crawled sources
- **Novelty** — rewards lower-popularity, newer, editorially surfaced, and non-library tracks
- **Familiarity** — penalizes songs you already played while still allowing deep cuts from artists you like

The backend returns lane-aware recommendations, reserving room for:

- **Radio hits** — recognizable anchors, capped so they do not dominate
- **Popular** — familiar but less obvious songs
- **Deep cuts / indie** — lower-popularity and editorially surfaced discoveries

Weights are controlled by the mode buttons and sliders in the Radio view.

Discovery pipeline:

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
| `POST /ingest/sources` | Crawl RSS + Reddit feeds, create new artists/tracks, and model fresh source finds |
| `POST /ingest/setup-all` | Run the full Music Profile setup pipeline |
| `POST /playlist-from-tracks` | Export discover session to Spotify playlist |
| `POST /synthesize/for-artist` | Generate "Why this?" explanation via Claude |

---

## Docs

- [`docs/SETUP.md`](docs/SETUP.md) — detailed setup with every API key
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — design decisions
- [`docs/PRODUCTION_AUDIT.md`](docs/PRODUCTION_AUDIT.md) — known issues and roadmap
- [`docs/SOURCES.md`](docs/SOURCES.md) — editorial source list
