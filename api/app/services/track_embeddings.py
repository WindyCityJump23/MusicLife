"""
Track embedding service.

Mirrors artist_embeddings.py: for each row in public.tracks where
embedding_source IS NOT NULL and embedding IS NULL, batch-embed the
source string and write the vector back.

Uses admin_supabase (service role) to bypass RLS — trusted backend job.
"""

from __future__ import annotations

import time

from app.services.embedding import embedder
from app.services.supabase_client import admin_supabase

BATCH_SIZE = 128

# Tracks are far more numerous than artists, so the safety cap is higher.
MAX_TOTAL = 20000


def run_track_embeddings(batch_size: int = BATCH_SIZE) -> dict:
    """Process all un-embedded tracks in batches. Returns summary stats."""
    total_embedded = 0
    total_skipped = 0
    batch_num = 0
    last_error: str | None = None
    consecutive_failures = 0

    MAX_CONSECUTIVE_FAILURES = 2

    while total_embedded + total_skipped < MAX_TOTAL:
        batch_num += 1

        result = (
            admin_supabase.table("tracks")
            .select("id, name, spotify_track_id, embedding_source")
            .not_.is_("embedding_source", "null")
            .is_("embedding", "null")
            .limit(batch_size)
            .execute()
        )

        candidates = result.data or []
        if not candidates:
            print(
                f"track_embeddings: no more candidates "
                f"(after {batch_num - 1} batches)"
            )
            break

        print(
            f"track_embeddings: batch {batch_num} — embedding "
            f"{len(candidates)} tracks"
        )

        valid: list[dict] = []
        invalid_count = 0
        for track in candidates:
            raw = track.get("embedding_source")
            text = raw.strip() if isinstance(raw, str) else ""
            if not text:
                invalid_count += 1
                continue
            valid.append({**track, "embedding_source": text})

        if invalid_count:
            total_skipped += invalid_count

        if not valid:
            continue

        texts = [t["embedding_source"] for t in valid]

        try:
            vectors = embedder.embed(texts, input_type="document")
        except Exception as exc:
            err = f"embed API error: {type(exc).__name__}: {exc}"
            print(f"track_embeddings: batch {batch_num} {err}")
            last_error = str(exc)
            total_skipped += len(candidates)
            consecutive_failures += 1
            if consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                print(
                    f"track_embeddings: aborting after {consecutive_failures} "
                    f"consecutive embed failures — last error: {last_error}"
                )
                break
            time.sleep(2)
            continue

        if len(vectors) != len(valid):
            err = (
                f"vector count mismatch (got {len(vectors)}, "
                f"expected {len(valid)})"
            )
            print(f"track_embeddings: batch {batch_num} {err} — skipping batch")
            last_error = err
            total_skipped += len(valid)
            consecutive_failures += 1
            if consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                break
            continue

        # Update each row by primary key. We can't upsert on `id` here
        # because we'd need to include NOT NULL columns we didn't fetch
        # (artist_id, name, etc.); a per-row update is cleaner and just
        # as cheap at this batch size.
        try:
            for i, track in enumerate(valid):
                admin_supabase.table("tracks").update(
                    {"embedding": vectors[i]}
                ).eq("id", track["id"]).execute()
            total_embedded += len(valid)
            consecutive_failures = 0
            print(
                f"track_embeddings: batch {batch_num} done — "
                f"{total_embedded} total so far"
            )
        except Exception as exc:
            err = f"DB write error: {type(exc).__name__}: {exc}"
            print(f"track_embeddings: batch {batch_num} {err}")
            last_error = str(exc)
            total_skipped += len(valid)
            consecutive_failures += 1
            if consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                break

        if len(candidates) == batch_size:
            time.sleep(0.5)

    summary = {
        "embedded": total_embedded,
        "skipped": total_skipped,
        "batches": batch_num,
        "last_error": last_error,
    }
    print(f"track_embeddings: complete — {summary}")
    return summary


def backfill_embedding_source() -> dict:
    """Fill tracks.embedding_source for rows that are missing it.

    Builds a description string from artist name + track name + album so
    older rows (populated before this column existed) can be embedded
    without re-running the Spotify search.
    """
    updated = 0
    offset = 0
    page_size = 1000

    while True:
        resp = (
            admin_supabase.table("tracks")
            .select("id, name, album_name, artist_id")
            .is_("embedding_source", "null")
            .range(offset, offset + page_size - 1)
            .execute()
        )
        rows = resp.data or []
        if not rows:
            break

        artist_ids = sorted({r["artist_id"] for r in rows if r.get("artist_id")})
        artist_names: dict[int, str] = {}
        if artist_ids:
            a_resp = (
                admin_supabase.table("artists")
                .select("id, name")
                .in_("id", artist_ids)
                .execute()
            )
            for a in a_resp.data or []:
                artist_names[int(a["id"])] = a.get("name") or ""

        for r in rows:
            source = _build_embedding_source(
                artist_name=artist_names.get(int(r["artist_id"])) if r.get("artist_id") else None,
                track_name=r.get("name"),
                album_name=r.get("album_name"),
            )
            if not source:
                continue
            admin_supabase.table("tracks").update(
                {"embedding_source": source}
            ).eq("id", r["id"]).execute()
            updated += 1

        if len(rows) < page_size:
            break
        offset += page_size

    print(f"track_embeddings: backfilled embedding_source for {updated} tracks")
    return {"updated": updated}


def _build_embedding_source(
    artist_name: str | None,
    track_name: str | None,
    album_name: str | None,
) -> str:
    """Compose the text we embed for a track.

    Format: ``"{artist} – {title} – {album}"``. The artist name is the
    biggest single signal for genre/mood without a lyric corpus; the
    album name often carries era/style context.
    """
    parts = [
        (artist_name or "").strip(),
        (track_name or "").strip(),
        (album_name or "").strip(),
    ]
    parts = [p for p in parts if p]
    return " – ".join(parts)
