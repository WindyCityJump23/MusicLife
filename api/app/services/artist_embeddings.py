"""
Artist embedding service.

For each artist in public.artists where embedding_source IS NOT NULL and embedding IS NULL:
  1. Batch all embedding_source strings into a single Voyage API call.
  2. Write the resulting vectors back to the embedding column in one upsert.

Capped at batch_size (default 128) per run — ~64K tokens, safely under Voyage's 120K limit.
Uses admin_supabase (service role) to bypass RLS — this is a trusted backend job.
"""

from __future__ import annotations

from app.services.embedding import embedder
from app.services.supabase_client import admin_supabase


def run_artist_embeddings(batch_size: int = 18) -> None:
    result = (
        admin_supabase.table("artists")
        .select("id, name, embedding_source")
        .not_.is_("embedding_source", "null")
        .is_("embedding", "null")
        .limit(batch_size)
        .execute()
    )

    candidates = result.data or []
    if not candidates:
        print("artist_embeddings: no candidates found")
        return

    print(f"artist_embeddings: embedding {len(candidates)} artists")

    texts = [a["embedding_source"] for a in candidates]
    vectors = embedder.embed(texts, input_type="document")

    if len(vectors) != len(candidates):
        print(
            f"artist_embeddings: vector count mismatch "
            f"(got {len(vectors)}, expected {len(candidates)}) — aborting"
        )
        return

    # Batch upsert all embeddings in a single round-trip instead of N individual updates.
    rows = [
        {
            "id": artist["id"],
            "spotify_artist_id": artist.get("spotify_artist_id"),
            "name": artist["name"],
            "embedding_source": artist["embedding_source"],
            "embedding": vectors[i],
        }
        for i, artist in enumerate(candidates)
    ]
    admin_supabase.table("artists").upsert(rows, on_conflict="id").execute()
    print(f"artist_embeddings: wrote {len(candidates)} embeddings")
