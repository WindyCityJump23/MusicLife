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
    last_error: str | None = None
    consecutive_failures = 0

    # If we fail this many batches in a row without embedding anything, bail
    # out — re-querying the same un-embedded rows just burns API quota and
    # produces a misleading "N skipped" count.
    MAX_CONSECUTIVE_FAILURES = 2

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
        invalid_count = 0
        for artist in candidates:
            raw = artist.get("embedding_source")
            text = raw.strip() if isinstance(raw, str) else ""
            if not text:
                invalid_count += 1
                continue
            valid_candidates.append({**artist, "embedding_source": text})

        if invalid_count:
            total_skipped += invalid_count
            print(
                f"artist_embeddings: batch {batch_num} skipped {invalid_count} "
                "artists with blank embedding_source"
            )

        if not valid_candidates:
            continue

        texts = [a["embedding_source"] for a in valid_candidates]

        try:
            vectors = embedder.embed(texts, input_type="document")
        except Exception as exc:
            err = f"embed API error: {type(exc).__name__}: {exc}"
            print(f"artist_embeddings: batch {batch_num} {err}")
            last_error = str(exc)
            total_skipped += len(candidates)
            consecutive_failures += 1
            if consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                print(
                    f"artist_embeddings: aborting after {consecutive_failures} consecutive "
                    f"embed failures — last error: {last_error}"
                )
                break
            time.sleep(2)
            continue

        if len(vectors) != len(valid_candidates):
            err = (
                f"vector count mismatch (got {len(vectors)}, "
                f"expected {len(valid_candidates)})"
            )
            print(f"artist_embeddings: batch {batch_num} {err} — skipping batch")
            last_error = err
            total_skipped += len(valid_candidates)
            consecutive_failures += 1
            if consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                print(f"artist_embeddings: aborting after {consecutive_failures} consecutive failures")
                break
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
            consecutive_failures = 0
            print(f"artist_embeddings: batch {batch_num} done — {total_embedded} total so far")
        except Exception as exc:
            err = f"DB write error: {type(exc).__name__}: {exc}"
            print(f"artist_embeddings: batch {batch_num} {err}")
            last_error = str(exc)
            total_skipped += len(valid_candidates)
            consecutive_failures += 1
            if consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                print(
                    f"artist_embeddings: aborting after {consecutive_failures} consecutive "
                    f"DB write failures — last error: {last_error}"
                )
                break

        # Small delay between batches to be respectful of API rate limits
        if len(candidates) == batch_size:
            time.sleep(0.5)

    summary = {
        "embedded": total_embedded,
        "skipped": total_skipped,
        "batches": batch_num,
        "last_error": last_error,
    }
    print(f"artist_embeddings: complete — {summary}")
    return summary
