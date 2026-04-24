# Music Dashboard

A personal music discovery and playback dashboard built on the Spotify API, enriched with third-party editorial sources (music blogs, Reddit, Bandcamp) and powered by embeddings + LLM reasoning for taste-aware recommendations.

## Architecture

Three layers:

1. **Signal collection** — Spotify (library, listens), Last.fm + MusicBrainz (artist metadata, lineage), RSS blogs, Reddit, Bandcamp (editorial signal).
2. **Taste model** — embedding-based similarity + editorial weighting + LLM synthesis. Three signals combined: personal affinity, contextual fit (prompt), editorial heat.
3. **Dashboard** — Next.js web app with Spotify playback, prompt interface, tunable sliders, saved views.

## Stack

- **Web:** Next.js 14 (App Router), Tailwind, shadcn/ui, Spotify Web Playback SDK
- **API:** Python FastAPI — ingestion, embeddings, ranking
- **DB:** Supabase (Postgres + pgvector + auth + RLS)
- **Hosting:** Vercel (web) + Fly.io (api)
- **Embeddings:** Voyage AI or OpenAI
- **LLM:** Anthropic Claude

## Repo layout

```
web/          Next.js frontend
api/          FastAPI ingestion + ranking service
db/           SQL migrations and seed data
scripts/      One-off utilities (backfills, exports)
docs/         Design notes, API references, source list
```

## Build sequence

- **Week 1:** Spotify OAuth, Supabase schema, ingest library + listens, shell UI with playback
- **Week 2:** MusicBrainz + Last.fm enrichment, artist embeddings, personal taste vector, first "similar to my taste" query
- **Week 3:** Blog + Reddit ingestion, mentions table, combined ranking — the dashboard becomes alive
- **Week 4:** Prompt box, sliders, saved views, LLM synthesis cards, invite friends

## Getting started

See `docs/SETUP.md` for the step-by-step, including every API key you'll need and where to get it.
