"""Retrieval and diversity metrics for offline recommendation evals."""
from __future__ import annotations

import math
from collections import Counter


# ── Retrieval quality ────────────────────────────────────────────


def dcg_at_k(ranked_ids: list, relevant_ids: set, k: int) -> float:
    """Discounted Cumulative Gain at rank k. Assumes binary relevance."""
    return sum(
        1.0 / math.log2(i + 2)
        for i, item in enumerate(ranked_ids[:k])
        if item in relevant_ids
    )


def ndcg_at_k(ranked_ids: list, relevant_ids: set, k: int) -> float:
    """Normalized DCG at k. Returns 0 when no relevant items exist."""
    ideal = dcg_at_k(sorted(relevant_ids)[:k], relevant_ids, k)
    return dcg_at_k(ranked_ids, relevant_ids, k) / ideal if ideal > 0 else 0.0


def mrr(ranked_ids: list, relevant_ids: set) -> float:
    """Mean Reciprocal Rank: reciprocal position of first relevant item."""
    for i, item in enumerate(ranked_ids):
        if item in relevant_ids:
            return 1.0 / (i + 1)
    return 0.0


def precision_at_k(ranked_ids: list, relevant_ids: set, k: int) -> float:
    hits = sum(1 for item in ranked_ids[:k] if item in relevant_ids)
    return hits / k if k > 0 else 0.0


def recall_at_k(ranked_ids: list, relevant_ids: set, k: int) -> float:
    if not relevant_ids:
        return 0.0
    hits = sum(1 for item in ranked_ids[:k] if item in relevant_ids)
    return hits / len(relevant_ids)


# ── Diversity and novelty ────────────────────────────────────────


def genre_diversity_score(results: list[dict]) -> float:
    """Fraction of unique primary genres (higher = more diverse)."""
    if not results:
        return 0.0
    genres = [_primary_genre(r) for r in results]
    return len(set(genres)) / len(genres)


def max_genre_fraction(results: list[dict]) -> float:
    """Highest fraction a single genre occupies in results."""
    if not results:
        return 0.0
    counts = Counter(_primary_genre(r) for r in results)
    return max(counts.values()) / len(results)


def artist_diversity_score(results: list[dict]) -> float:
    """Fraction of unique artists in song results (should be 1.0 after reranking)."""
    if not results:
        return 0.0
    artists = [r.get("artist_name", "").lower() for r in results]
    return len(set(artists)) / len(artists)


def novelty_rate(results: list[dict], library_artist_ids: set[int]) -> float:
    """Fraction of results whose artist is NOT in the user's library."""
    if not results:
        return 0.0
    novel = sum(
        1 for r in results if int(r.get("artist_id") or 0) not in library_artist_ids
    )
    return novel / len(results)


def score_spread(results: list[dict]) -> float:
    """Range of scores in a result set (max - min). Indicates ranking confidence."""
    if len(results) < 2:
        return 0.0
    scores = [r.get("score", 0.0) for r in results]
    return max(scores) - min(scores)


# ── Helpers ──────────────────────────────────────────────────────


def _primary_genre(result: dict) -> str:
    genres = result.get("genres") or []
    return genres[0].lower() if genres else "__none__"
