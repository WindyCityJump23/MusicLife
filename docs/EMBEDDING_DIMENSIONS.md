# Changing the embedding dimension

The catalog stores embeddings as `vector(1024)` (`artists.embedding`,
`tracks.embedding`, `mentions.embedding`). pgvector column dimensions are fixed
at column-definition time, so a provider/model change that alters the dimension
is a deliberate migration — not a runtime config flip.

## What's already parameterized

- `EMBEDDING_DIMS` (api config) is the single source the embedder honors. The
  OpenAI path passes `dimensions=settings.embedding_dims` so it returns vectors
  that match the schema instead of its native 3072 (see
  `api/app/services/embedding.py`).
- `api/app/startup_check.py` warns at boot when `EMBEDDING_DIMS` and the schema
  (1024) disagree, so a mismatch surfaces immediately rather than as an embed
  job that silently produces zero rows.

## To switch dimensions (e.g. 1024 → 1536)

1. **Pick a model** whose output (or `dimensions=` override) matches the target.
2. **Write a migration** (next number in `db/migrations/`) that drops the vector
   indexes, alters the column types, and recreates the indexes:

   ```sql
   -- 0NN_change_embedding_dims.sql  (example: 1024 -> 1536)
   drop index if exists idx_artists_embedding;
   drop index if exists idx_mentions_embedding;
   -- (drop any track embedding index from 011_track_embeddings.sql)

   alter table public.artists  alter column embedding type vector(1536) using null;
   alter table public.tracks   alter column embedding type vector(1536) using null;
   alter table public.mentions alter column embedding type vector(1536) using null;

   create index idx_artists_embedding  on public.artists  using ivfflat (embedding vector_cosine_ops);
   create index idx_mentions_embedding on public.mentions using ivfflat (embedding vector_cosine_ops);
   ```

   Also update the `vector(1024)` signatures in the pgvector RPCs
   (`db/migrations/017_pgvector_rpcs.sql`) to the new dimension.

3. **Update config**: `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `EMBEDDING_DIMS`.
4. **Re-embed everything.** The `using null` above clears existing vectors
   (they're the wrong dimension). Re-run the embed jobs:
   `POST /ingest/embed-artists` and `POST /ingest/embed-tracks`.
5. **Verify** with `SELECT vector_dims(embedding) FROM artists WHERE embedding IS NOT NULL LIMIT 1;`

> ⚠️ Do not place this template as a `.sql` under `db/migrations/` until you mean
> to run it — `make migrate` executes every file in that folder.
