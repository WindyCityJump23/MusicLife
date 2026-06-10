"""Multi-centroid taste modeling.

A single taste centroid averages a multi-genre listener (jazz + techno) into
the middle of embedding space, where nothing is actually a strong match. This
module clusters the user's weighted library embeddings into up to ``k``
centroids (cosine k-means, deterministic, dependency-free) so candidate
retrieval can search near *each* of the user's taste modes.

Pure functions — no database access; unit-tested in tests/test_taste_model.py.
"""

from __future__ import annotations

import math


def _norm(vec: list[float]) -> list[float]:
    magnitude = math.sqrt(sum(v * v for v in vec))
    if magnitude == 0:
        return list(vec)
    return [v / magnitude for v in vec]


def _cos(a: list[float], b: list[float]) -> float:
    # Inputs are normalized, so the dot product is the cosine similarity.
    return sum(x * y for x, y in zip(a, b))


def _weighted_mean(vectors: list[list[float]], weights: list[float]) -> list[float] | None:
    total = 0.0
    acc: list[float] | None = None
    for vec, weight in zip(vectors, weights):
        if weight <= 0:
            continue
        if acc is None:
            acc = [0.0] * len(vec)
        for i, val in enumerate(vec):
            acc[i] += val * weight
        total += weight
    if acc is None or total == 0:
        return None
    return [v / total for v in acc]


def cluster_taste_vectors(
    vectors: list[list[float]],
    weights: list[float] | None = None,
    *,
    k: int = 3,
    iterations: int = 8,
    min_cluster_weight_share: float = 0.12,
) -> list[list[float]]:
    """Cluster weighted embeddings into up to ``k`` taste centroids.

    Returns centroids ordered by total cluster weight (dominant taste first).
    Clusters carrying less than ``min_cluster_weight_share`` of the total
    weight are dropped — a handful of outlier artists should not earn their
    own retrieval pool. With fewer than ~2*k usable vectors this degrades to
    a single weighted-mean centroid, matching the legacy behavior.
    """
    usable = [
        (vec, (weights[i] if weights and i < len(weights) else 1.0))
        for i, vec in enumerate(vectors)
        if vec
    ]
    usable = [(vec, w) for vec, w in usable if w > 0]
    if not usable:
        return []

    vecs = [_norm(v) for v, _ in usable]
    wts = [w for _, w in usable]
    total_weight = sum(wts)

    single = _weighted_mean(vecs, wts)
    if single is None:
        return []
    if k <= 1 or len(vecs) < 2 * k:
        return [single]

    # Deterministic k-means++-style seeding: heaviest vector first, then the
    # weighted-farthest vector from any existing seed.
    seed_indices = [max(range(len(vecs)), key=lambda i: wts[i])]
    while len(seed_indices) < k:
        def distance_score(i: int) -> float:
            nearest = max(_cos(vecs[i], vecs[j]) for j in seed_indices)
            return (1.0 - nearest) * wts[i]
        candidate = max(range(len(vecs)), key=distance_score)
        if candidate in seed_indices:
            break
        seed_indices.append(candidate)
    centroids = [list(vecs[i]) for i in seed_indices]

    assignments = [0] * len(vecs)
    for _ in range(iterations):
        changed = False
        for i, vec in enumerate(vecs):
            best = max(range(len(centroids)), key=lambda c: _cos(vec, centroids[c]))
            if best != assignments[i]:
                assignments[i] = best
                changed = True
        new_centroids: list[list[float]] = []
        for c in range(len(centroids)):
            members = [vecs[i] for i in range(len(vecs)) if assignments[i] == c]
            member_wts = [wts[i] for i in range(len(vecs)) if assignments[i] == c]
            mean = _weighted_mean(members, member_wts)
            new_centroids.append(_norm(mean) if mean else centroids[c])
        centroids = new_centroids
        if not changed:
            break

    cluster_weights = [0.0] * len(centroids)
    for i in range(len(vecs)):
        cluster_weights[assignments[i]] += wts[i]

    kept = [
        (cluster_weights[c], centroids[c])
        for c in range(len(centroids))
        if cluster_weights[c] / total_weight >= min_cluster_weight_share
    ]
    if not kept:
        return [single]
    kept.sort(key=lambda pair: pair[0], reverse=True)
    return [centroid for _, centroid in kept]
