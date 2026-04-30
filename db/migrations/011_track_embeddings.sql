-- Track-level embeddings.
--
-- Until now the ranker scored tracks by inheriting their artist's score,
-- so a prompt-vs-track context match was really a prompt-vs-artist match.
-- These columns let us embed each track ("artist – title – album") and
-- compute cosine similarity at the track level.

alter table public.tracks
  add column if not exists embedding_source text,
  add column if not exists embedding vector(1024);

create index if not exists idx_tracks_embedding
  on public.tracks using ivfflat (embedding vector_cosine_ops);

create index if not exists idx_tracks_pending_embedding
  on public.tracks(id)
  where embedding is null and embedding_source is not null;
