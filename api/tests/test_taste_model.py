"""Unit tests for the multi-centroid taste model (cosine k-means)."""

import math
import random

from app.services.taste_model import cluster_taste_vectors


def _noisy(base: list[float], rng: random.Random, scale: float = 0.05) -> list[float]:
    return [v + rng.uniform(-scale, scale) for v in base]


def _cos(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


class TestClusterTasteVectors:
    def test_empty_input(self):
        assert cluster_taste_vectors([], []) == []

    def test_single_vector_returns_one_centroid(self):
        vecs = [[1.0, 0.0, 0.0]]
        clusters = cluster_taste_vectors(vecs, [1.0], k=3)
        assert len(clusters) == 1

    def test_small_library_degrades_to_single_centroid(self):
        # Fewer than 2*k vectors -> legacy single weighted mean.
        vecs = [[1.0, 0.0], [0.9, 0.1], [0.0, 1.0]]
        clusters = cluster_taste_vectors(vecs, [1.0, 1.0, 1.0], k=3)
        assert len(clusters) == 1

    def test_recovers_two_obvious_clusters(self):
        rng = random.Random(42)
        jazz = [1.0, 0.0, 0.0, 0.0]
        techno = [0.0, 1.0, 0.0, 0.0]
        vecs = [_noisy(jazz, rng) for _ in range(10)] + [_noisy(techno, rng) for _ in range(10)]
        weights = [1.0] * 20
        clusters = cluster_taste_vectors(vecs, weights, k=2)
        assert len(clusters) == 2
        # Each true mode should be close to one of the centroids.
        assert max(_cos(jazz, c) for c in clusters) > 0.95
        assert max(_cos(techno, c) for c in clusters) > 0.95

    def test_dominant_cluster_is_first(self):
        rng = random.Random(7)
        major = [1.0, 0.0, 0.0, 0.0]
        minor = [0.0, 1.0, 0.0, 0.0]
        vecs = [_noisy(major, rng) for _ in range(15)] + [_noisy(minor, rng) for _ in range(5)]
        weights = [1.0] * 20
        clusters = cluster_taste_vectors(vecs, weights, k=2)
        assert len(clusters) == 2
        assert _cos(major, clusters[0]) > _cos(minor, clusters[0])

    def test_tiny_outlier_cluster_is_dropped(self):
        rng = random.Random(3)
        main = [1.0, 0.0, 0.0, 0.0]
        outlier = [0.0, 0.0, 0.0, 1.0]
        # 19 main vectors and one outlier: the outlier carries <12% weight.
        vecs = [_noisy(main, rng) for _ in range(19)] + [outlier]
        weights = [1.0] * 20
        clusters = cluster_taste_vectors(vecs, weights, k=2)
        assert len(clusters) == 1
        assert _cos(main, clusters[0]) > 0.95

    def test_deterministic(self):
        rng = random.Random(11)
        vecs = [_noisy([1.0, 0.0], rng) for _ in range(8)] + [_noisy([0.0, 1.0], rng) for _ in range(8)]
        weights = [1.0] * 16
        a = cluster_taste_vectors(vecs, weights, k=2)
        b = cluster_taste_vectors(vecs, weights, k=2)
        assert a == b

    def test_zero_weights_ignored(self):
        vecs = [[1.0, 0.0], [0.0, 1.0]]
        clusters = cluster_taste_vectors(vecs, [1.0, 0.0], k=2)
        assert len(clusters) == 1
