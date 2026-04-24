# Architecture decisions

This project is intentionally split into three services so each concern can evolve independently:

1. **`web/` (Next.js)**
   - Handles Spotify OAuth, UI state, playback UX, and user-facing controls.
   - Should remain mostly stateless and avoid direct DB access.
2. **`api/` (FastAPI)**
   - Orchestrates ingestion, enrichment, embeddings, ranking, and synthesis.
   - Keeps provider keys server-side and centralizes business logic.
3. **`db/` (Supabase/Postgres + pgvector)**
   - Stores durable user history, artist/track graph, editorial mentions, and playlist state.

## Why mentions are embedded separately

Mentions are embedded at the excerpt level (not just per-source or per-artist aggregate) so prompt matching can stay contextual:

- A single artist can appear in mixed contexts across multiple outlets.
- Prompt embeddings can match only the specific mention snippets relevant to a user's current intent.
- We can aggregate contextual fit per artist at query-time while preserving traceability for synthesis cards.

## Recommendation model (three signals)

Final recommendation score is a weighted blend controlled by UI sliders:

- **Affinity**: candidate artist embedding similarity to the user's taste centroid.
- **Context**: similarity between optional prompt embedding and mention embeddings.
- **Editorial**: recency/frequency/trust-weighted mention momentum.

`score = w_affinity * affinity + w_context * context + w_editorial * editorial`

## Ingestion strategy

- Spotify ingestion runs first to establish user taste anchors.
- Artist enrichment (MusicBrainz/Last.fm) fills canonical metadata and tags.
- Embedding jobs run over artist bios + editorial excerpts.
- Source ingestion then continuously updates mention heat.
