"""
Ranking primitives.

Implementation notes (SQL-first approach):

1) build_taste_vector(user_id)
   - Join `user_tracks -> tracks -> artists`.
   - Use play_count as weight (fallback 1).
   - Compute weighted centroid of `artists.embedding` in SQL.

2) rank_candidates(...)
   - Candidate set: artists with embeddings, optionally excluding user's library artists.
   - Affinity score: cosine similarity(candidate.embedding, taste_vector)
   - Context score: if prompt vector exists, aggregate top mention similarity per artist.
   - Editorial score: weighted mention heat using source trust + recency + frequency + sentiment.
   - Final score = w_affinity*affinity + w_context*context + w_editorial*editorial

This module currently returns safe placeholder outputs until SQL/RPC functions are wired.
"""


def build_taste_vector(user_id: str) -> list[float]:
    # Placeholder until pgvector SQL function is added.
    # Returning an empty vector keeps endpoint behavior deterministic during setup.
    _ = user_id
    return []


def rank_candidates(
    user_id: str,
    taste_vector: list[float],
    prompt_vector: list[float] | None,
    weights: dict[str, float],
    exclude_library: bool,
    limit: int,
) -> list[dict]:
    _ = (user_id, taste_vector, prompt_vector, weights, exclude_library)
    # Placeholder result shape expected by web UI.
    return [
        {
            "artist_id": "placeholder",
            "artist_name": "Ranking not yet wired",
            "score": 0.0,
            "reasons": ["Connect SQL ranking queries in app/services/ranking.py"],
        }
    ][: max(limit, 0)]
