# Production Audit (April 24, 2026)

This audit tracks what has been fixed and what remains.

## Completed fixes

1. **Ranking and taste-vector — implemented** ✅
   - `app/services/ranking.py` now computes real affinity, context, and editorial scores in-process.
   - Weight normalization and `limit` bounds validated at the request layer.

2. **OAuth CSRF hardening** ✅
   - `state` nonce generated on login and validated on callback.
   - Cookie lifetimes tightened; `sp_refresh` only set when Spotify provides a refresh token.

3. **CORS locked to env allowlist** ✅
   - `CORS_ORIGINS` env var parsed into a list and passed to `CORSMiddleware`.

4. **RLS and per-request user-scoped clients** ✅
   - `db/migrations/003_rls.sql` enables RLS on all user-owned and catalog tables.
   - `/recommend` uses `get_validated_user_scoped_supabase` — service-role client is only used for trusted backend jobs.
   - `ranking.py` functions accept a `client` parameter instead of using a global service-role client.

## Remaining work

### High priority

5. **Spotify ingestion does not persist**
   - `app/services/spotify_ingest.py` fetches saved tracks, top artists, and recent plays but never writes to Supabase.
   - Blocks end-to-end library ingestion and means all user taste vectors will be empty.

6. **No token refresh mechanism**
   - Spotify access tokens expire after ~1 hour. There is no route or background job to call the refresh token endpoint and reissue `sp_access`.
   - Users will hit 401s from Spotify after the initial session without re-authenticating.

7. **Add ingestion idempotency + dedupe keys**
   - `mentions` needs a uniqueness key such as `(source_id, url, artist_id, published_at)` or a content hash.
   - `listen_events` needs unique source event IDs or a hash to avoid duplicates on re-ingest.

### Data model

- **Missing indexes for common filters**:
  - `mentions(source_id, published_at desc)`
  - `listen_events(user_id, listened_at desc)`
  - partial indexes on null-heavy filter columns
- **Vector index tuning not specified** (`lists`, `probes`, and ANALYZE cadence).
- **Embedding dimension consistency**: schema fixes embeddings to `vector(1024)`; OpenAI `text-embedding-3-large` returns 3072 dimensions unless `dimensions` is explicitly requested.

### Ranking system

- No calibration between signals — affinity, context, and editorial are on roughly comparable [0, 1] ranges after normalization, but thresholds (0.55 / 0.45) are untested on real data.
- Better production approach:
  - Two-stage retrieval: ANN candidate generation → re-rank top N.
  - Persist feature values for offline weight tuning.
  - Add anti-repetition and freshness decay.

### Ingestion pipeline

- No retry/backoff/jitter or dead-letter handling in Spotify ingest.
- Suggested: idempotent `job_runs` table with status transitions, raw `jsonb` payload snapshots for replay.

### Frontend

- Dashboard page is a placeholder; no API calls or state management wired up.
- No loading/error/empty-state strategy for ranking and synthesis views.
- Suggested: server actions or route handlers as a BFF layer to avoid exposing backend keys to the browser.

## Concrete phased plan

### Phase 1 (done ✅)
- Implement ranking with real signals and request validation.
- Add OAuth state checks and cookie hardening.
- Move CORS to env allowlist.
- Enforce RLS and per-request user-scoped clients.

### Phase 2 (next)
- Implement Spotify ingest persistence (artists, tracks, user_tracks, listen_events upserts).
- Add Spotify token refresh route.
- Add dedupe constraints + migration backfills.
- Add ingestion retries, run logs, and alerting.

### Phase 3 (quality and scale)
- Wire up dashboard with real API calls.
- Two-stage retrieval + rerank calibration on real data.
- Offline eval set and weight tuning loop.
- Caching for hot prompts and top cohorts.
