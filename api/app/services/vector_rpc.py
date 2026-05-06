"""Thin wrappers around the pgvector RPCs in migration 017.

Keeps the SQL serialization details (vector text format, exclude-id
arrays, RPC error handling) out of the ranking modules.
"""

from __future__ import annotations

from supabase import Client

from app.services.supabase_client import retry_on_disconnect


def serialize_vector(vec: list[float]) -> str | None:
    """Encode a list[float] as the pgvector text literal '[v1,v2,...]'.

    PostgREST will cast the string to vector(1024) when the RPC parameter
    is typed as vector. Returns None for empty input so the SQL parameter
    is NULL (which the RPC handles via the popularity-fallback branch).
    """
    if not vec:
        return None
    return "[" + ",".join(f"{float(x):.7g}" for x in vec) + "]"


def match_artists(
    client: Client,
    query_vector: list[float] | None,
    match_count: int,
    exclude_ids: list[int] | None = None,
    genre_tokens: list[str] | None = None,
) -> list[dict]:
    """Fetch the candidate artist pool.

    - When query_vector is non-empty, rows are ordered by cosine similarity
      and the `similarity` field carries the cosine in [-1, 1].
    - When empty/None, rows are ordered by popularity and `similarity`=0.
    - genre_tokens applies a fuzzy substring filter to artists.genres[].
    - exclude_ids drops those artist IDs (used when exclude_library=True).

    Returns rows: {id, name, popularity, genres, spotify_artist_id, similarity}.
    Never returns the embedding column.
    """
    payload = {
        "query_embedding": serialize_vector(query_vector or []),
        "match_count": int(match_count),
        "exclude_ids": list(exclude_ids or []),
        "genre_tokens": [t for t in (genre_tokens or []) if t] or None,
    }
    try:
        resp = retry_on_disconnect(
            lambda: client.rpc("match_artists_by_embedding", payload).execute()
        )
        return resp.data or []
    except Exception as exc:
        print(f"vector_rpc.match_artists failed: {exc}")
        return []


def max_mention_similarity_per_artist(
    client: Client,
    query_vector: list[float],
    artist_ids: list[int],
) -> dict[int, float]:
    """Per-artist max cosine similarity of any of their mentions to query."""
    if not query_vector or not artist_ids:
        return {}
    payload = {
        "query_embedding": serialize_vector(query_vector),
        "artist_ids": list(artist_ids),
    }
    try:
        resp = retry_on_disconnect(
            lambda: client.rpc("max_mention_similarity_per_artist", payload).execute()
        )
    except Exception as exc:
        print(f"vector_rpc.max_mention_similarity_per_artist failed: {exc}")
        return {}
    return {
        int(row["artist_id"]): float(row.get("max_similarity") or 0.0)
        for row in (resp.data or [])
        if row.get("artist_id") is not None
    }


def track_similarity_for_artists(
    client: Client,
    query_vector: list[float],
    artist_ids: list[int],
) -> dict[int, float]:
    """Per-track cosine similarity (track.embedding vs query) for given artists."""
    if not query_vector or not artist_ids:
        return {}
    payload = {
        "query_embedding": serialize_vector(query_vector),
        "artist_ids": list(artist_ids),
    }
    try:
        resp = retry_on_disconnect(
            lambda: client.rpc("track_similarity_for_artists", payload).execute()
        )
    except Exception as exc:
        print(f"vector_rpc.track_similarity_for_artists failed: {exc}")
        return {}
    return {
        int(row["track_id"]): float(row.get("similarity") or 0.0)
        for row in (resp.data or [])
        if row.get("track_id") is not None
    }
