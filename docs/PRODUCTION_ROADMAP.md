# Production roadmap

Tracks the improvement work from the engineering review. Items are grouped by
the three phases; ✅ = landed in this branch, ◻️ = designed/scaffolded and
awaiting a staging environment or a follow-up.

## Phase 1 — polish & reliability ✅

- ✅ Removed the live `/api/auth/debug` route and the dead onboarding wizard.
- ✅ Gated `POST /diagnostics/ranking/static` behind bearer auth.
- ✅ Pinned the API venv to Python 3.11+ in the Makefile (3.9 broke PEP 604).
- ✅ Centralized the readiness formula (`web/lib/readiness.ts`) and replaced
  three overlapping 30s pollers with one shared `ReadinessProvider`.
- ✅ "Why this?" card copy now leads with the most distinguishing fact.
- ✅ `/api/radio-health` exposes the live-vs-catalog `source_mix` ratio.

## Phase 2 — product & engineering improvements ✅

- ✅ Extracted pure station helpers from the 3,458-line `discover-view.tsx` into
  `web/lib/station/` (types, explanation, lanes) + 32 vitest tests.
- ✅ Extracted pure scoring/lane/strategy helpers from the 2,126-line
  `song_ranking.py` into `song_scoring.py` + 43 pytest tests.
- ✅ Test layer: vitest (web) + pytest (api) wired into CI; cross-tenant
  isolation contract test; Playwright smoke scaffold (`npm run test:e2e`).
- ✅ Wired the Claude "Why this?" synthesis into the card expand (lazy, with
  graceful fallback); made the inactive audio-feature path observable.

## Phase 3 — architecture & recommendation quality

- ✅ Per-user token-bucket rate limiting on `/recommend*`
  (`app/services/rate_limit.py`, returns 429 + Retry-After) + tests.
- ✅ Keep-alive workflow (`.github/workflows/keepalive.yml`) pings `/health`
  every 10 min to mitigate Render free-tier cold starts.
- ✅ Embedding-dimension change procedure documented
  (`docs/EMBEDDING_DIMENSIONS.md`); embedder already honors `EMBEDDING_DIMS`.
- ◻️ **RLS / JWT activation** — building blocks landed (`web/lib/supabase-jwt.ts`
  + tests, contract test). Cutover is documented in
  `docs/RLS_JWT_MIGRATION.md` and intentionally **not** flipped on the live
  auth path; it needs staging validation first (a wrong secret/claim locks
  users out).
- ◻️ **Catalog depth** — the live station still skews toward live Spotify
  search over the scored catalog. Watch `live_source_ratio` in radio-health and
  invest in track-population coverage so the designed 45/35/20 lane mix drives
  the queue. (Operational; needs prod data.)
- ◻️ **Parallelize recommendation context fetches** — `recommend_songs` issues
  ~12 sequential Supabase round-trips before ranking and re-ranks up to 5×.
  Gather the independent fetches and cache the slow-changing per-user taste
  profile. (Guard with the eval suite.)
- ◻️ **Distributed rate limiting / job queue** — the in-process limiter and
  `BackgroundTasks` are per-instance. Moving to Redis + a real worker is the
  scale-out path once there's more than one API instance.
- ◻️ **Paid Render tier** — the durable fix for cold starts; keep-alive is a
  mitigation, not a guarantee.

## How to validate locally

```bash
# API (needs Python 3.11+; this repo provisions it via `uv` if available)
cd api && python -m pytest && python -m evals.run_evals --suite ranking,songs,context,synthesis

# Web
cd web && npm test && npm run build

# E2E smoke against a deployment
cd web && npx playwright install chromium && SMOKE_BASE_URL=https://… npm run test:e2e
```
