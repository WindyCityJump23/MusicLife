# Production Audit (April 24, 2026)

This audit focuses on what will fail first in production and what should be simplified now.

## Highest-impact fixes (do first)

1. **Implement real ranking and taste-vector SQL now**
   - `app/services/ranking.py` still returns placeholder records.
   - Impact: recommendation quality is effectively non-functional.

2. **Harden OAuth flow (CSRF + cookie hygiene)**
   - Add OAuth `state` nonce and verify it in callback.
   - Shorten cookie lifetime and avoid setting missing refresh token.

3. **Lock down API ingress + CORS**
   - Restrict CORS via env allowlist (dev + prod origins).
   - Require authenticated caller context for ingestion/recommend endpoints.

4. **Enforce RLS and tenant isolation in query paths**
   - Current API uses service-role client globally. Keep service role for cron only.
   - User-triggered paths should run as user JWT or via explicit ownership checks.

5. **Add ingestion idempotency + dedupe keys**
   - Mentions and listen events need deterministic upsert keys to stop duplicate growth.

## Data model review

### Strengths
- Core entities are present (`artists`, `tracks`, `user_tracks`, `listen_events`, `sources`, `mentions`).
- `mentions` as excerpt-level embedding unit is the right abstraction for contextual retrieval.

### Gaps / risks
- **No RLS policies are defined in migrations** even though RLS is a hard requirement.
- **Embedding dimension mismatch risk**: schema fixes embeddings to `vector(1024)` while OpenAI `text-embedding-3-large` returns larger vectors unless requested with dimensions.
- **Missing uniqueness constraints for dedupe**:
  - `mentions` should have a uniqueness key such as `(source_id, url, artist_id, published_at)` or source-specific hash.
  - `listen_events` should include unique source event IDs or hash to avoid repeated ingest duplication.
- **Missing indexes for common filters**:
  - `mentions(source_id, published_at desc)`
  - `listen_events(user_id, listened_at desc)`
  - partial indexes where null-heavy columns are used in filters.
- **Vector index tuning not specified** (`lists`, `probes`, and ANALYZE cadence).

## Ranking system review

### Current issues
- Actual rank computation is not implemented; endpoint returns placeholder data.
- No weight normalization/validation in API contract.
- No calibration between signals (affinity/context/editorial likely on different scales).

### Better production approach
- Normalize each signal to comparable ranges (z-score per batch or min-max by candidate set).
- Use two-stage retrieval:
  1. Candidate generation from affinity + context ANN queries.
  2. Re-rank top N with editorial and business rules.
- Add basic anti-repetition and freshness constraints.
- Persist feature values in `surfaced` for offline evaluation and weight tuning.

## Ingestion pipeline review

### Risks
- Current Spotify ingest service fetches data but does not persist.
- No retry/backoff/jitter and no dead-letter handling.
- No parser quality instrumentation for RSS/Reddit extraction.

### Improvements
- Add idempotent job model with `job_runs` table and status transitions.
- Store raw payload snapshots (`jsonb`) for replay/debug.
- Use content fingerprinting (`sha256(cleaned_excerpt)`) before embedding.
- Batch embeddings and apply concurrency + rate-limit controls.

## Frontend review

### Risks
- Dashboard page is placeholder; no production data wiring yet.
- OAuth callback currently stores tokens only in cookies; no persistent token lifecycle strategy.
- No loading/error/empty-state strategy for ranking and synthesis views.

### Improvements
- Use server actions or route handlers as BFF layer and avoid exposing backend service keys.
- Add optimistic UI for slider tuning with debounced recommend requests.
- Add explainability affordances: citation chips linking to mention sources.

## Concrete phased plan

### Phase 1 (stability)
- Implement ranking SQL + strict request validation.
- Add OAuth state checks and cookie hardening.
- Move CORS to env allowlist.

### Phase 2 (data correctness)
- Add RLS policies and ownership checks.
- Add dedupe constraints + migration backfills.
- Add ingestion retries, run logs, and alerting.

### Phase 3 (quality and scale)
- Two-stage retrieval + rerank calibration.
- Offline eval set and weight tuning loop.
- Caching for hot prompts and top cohorts.
