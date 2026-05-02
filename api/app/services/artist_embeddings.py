"""
Artist embedding service.

For each artist in public.artists where embedding_source IS NOT NULL and embedding IS NULL:
  1. Batch embedding_source strings into Voyage/OpenAI API calls.
  2. Write the resulting vectors back to the embedding column.

Now auto-loops through ALL un-embedded artists instead of capping at a small batch.
Processes in batches of 64 to stay within API token limits, and reports progress.

Uses admin_supabase (service role) to bypass RLS — this is a trusted backend job.
"""

from __future__ import annotations

import time

from app.services.embedding import embedder
from app.services.supabase_client import admin_supabase

# Max artists per API call. Voyage allows ~120K tokens per request;
# at ~500 tokens per embedding_source, 64 is safe (~32K tokens).
BATCH_SIZE = 64

# Max total artists per job run (safety cap to avoid infinite loops / cost spikes)
MAX_TOTAL = 2000


def run_artist_embeddings(batch_size: int = BATCH_SIZE) -> dict:
    """Process all un-embedded artists in batches. Returns summary stats."""
    total_embedded = 0
    total_skipped = 0
    batch_num = 0

    while total_embedded + total_skipped < MAX_TOTAL:
        batch_num += 1

        result = (
            admin_supabase.table("artists")
            .select("id, name, spotify_artist_id, embedding_source")
            .not_.is_("embedding_source", "null")
            .is_("embedding", "null")
            .limit(batch_size)
            .execute()
        )

        candidates = result.data or []
        if not candidates:
            print(f"artist_embeddings: no more candidates (after {batch_num - 1} batches)")
            break

        print(f"artist_embeddings: batch {batch_num} — embedding {len(candidates)} artists")

        # Keep candidate/text alignment stable and skip blank sources so one
        # malformed row does not poison the entire batch.
        valid_candidates: list[dict] = []
        invalid_rows: list[dict] = []
        invalid_count = 0
        for artist in candidates:
            raw = artist.get("embedding_source")
            text = raw.strip() if isinstance(raw, str) else ""
            if not text:
                invalid_count += 1
                invalid_rows.append({"id": artist["id"], "embedding_source": None})
                continue
            valid_candidates.append({**artist, "embedding_source": text})

        if invalid_count:
            total_skipped += invalid_count
            print(
                f"artist_embeddings: batch {batch_num} skipped {invalid_count} "
                "artists with blank embedding_source"
            )
            # Prevent repeatedly selecting the same invalid rows forever.
            if invalid_rows:
                try:
                    admin_supabase.table("artists").upsert(invalid_rows, on_conflict="id").execute()
                except Exception as exc:
                    print(
                        "artist_embeddings: failed to null invalid embedding_source rows "
                        f"on batch {batch_num}: {exc}"
                    )

        if not valid_candidates:
            continue

        texts = [a["embedding_source"] for a in valid_candidates]

        try:
            vectors = embedder.embed(texts, input_type="document")
        except Exception as exc:
            print(f"artist_embeddings: embed API error on batch {batch_num}: {exc}")
            total_skipped += len(valid_candidates)
            # Wait a bit before retrying (might be rate limit)
            time.sleep(2)
            continue

        if len(vectors) != len(valid_candidates):
            print(
                f"artist_embeddings: vector count mismatch on batch {batch_num} "
                f"(got {len(vectors)}, expected {len(valid_candidates)}) — skipping batch"
            )
            total_skipped += len(valid_candidates)
            continue

        rows = [
            {
                "id": artist["id"],
                "spotify_artist_id": artist.get("spotify_artist_id"),
                "name": artist["name"],
                "embedding_source": artist["embedding_source"],
                "embedding": vectors[i],
            }
            for i, artist in enumerate(valid_candidates)
        ]

        try:
            admin_supabase.table("artists").upsert(rows, on_conflict="id").execute()
            total_embedded += len(valid_candidates)
            print(f"artist_embeddings: batch {batch_num} done — {total_embedded} total so far")
        except Exception as exc:
            print(f"artist_embeddings: DB write error on batch {batch_num}: {exc}")
            total_skipped += len(valid_candidates)

        # Small delay between batches to be respectful of API rate limits
        if len(candidates) == batch_size:
            time.sleep(0.5)

    summary = {
        "embedded": total_embedded,
        "skipped": total_skipped,
        "batches": batch_num,
    }
    print(f"artist_embeddings: complete — {summary}")
    return summary
