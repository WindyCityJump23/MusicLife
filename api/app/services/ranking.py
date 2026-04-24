"""Ranking primitives for recommendation generation.

The implementation is intentionally Python-first while schema and SQL RPCs
settle. It uses Supabase reads and computes the blend in-process.
"""

from __future__ import annotations

import math
from collections import defaultdict
from datetime import datetime, timezone

from supabase import Client


def _parse_vector(value: object) -> list[float]:
    if value is None:
        return []

    if isinstance(value, list):
        return [float(x) for x in value]

    if isinstance(value, str):
        text = value.strip()
        if text.startswith("[") and text.endswith("]"):
            body = text[1:-1].strip()
            if not body:
                return []
            return [float(part) for part in body.split(",")]

    return []


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0

    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def _normalize_01(value: float) -> float:
    # Map cosine range [-1, 1] into [0, 1].
    return max(0.0, min(1.0, (value + 1.0) / 2.0))


def _get_user_artist_weights(client: Client, user_id: str) -> dict[int, float]:
    tracks_resp = (
        client.table("user_tracks")
        .select("track_id,play_count")
        .eq("user_id", user_id)
        .execute()
    )
    user_tracks = tracks_resp.data or []
    if not user_tracks:
        return {}

    track_ids = [row.get("track_id") for row in user_tracks if row.get("track_id") is not None]
    if not track_ids:
        return {}

    tracks_map_resp = (
        client.table("tracks")
        .select("id,artist_id")
        .in_("id", track_ids)
        .execute()
    )
    tracks_map = tracks_map_resp.data or []
    track_to_artist = {row["id"]: row.get("artist_id") for row in tracks_map if row.get("id") is not None}

    artist_weights: dict[int, float] = defaultdict(float)
    for row in user_tracks:
        track_id = row.get("track_id")
        artist_id = track_to_artist.get(track_id)
        if artist_id is None:
            continue

        play_count = row.get("play_count") or 0
        weight = float(play_count if play_count > 0 else 1)
        artist_weights[int(artist_id)] += weight

    return dict(artist_weights)


def build_taste_vector(client: Client, user_id: str) -> list[float]:
    artist_weights = _get_user_artist_weights(client, user_id)
    if not artist_weights:
        return []

    artist_ids = list(artist_weights.keys())
    artists_resp = (
        client.table("artists")
        .select("id,embedding")
        .in_("id", artist_ids)
        .execute()
    )
    artists = artists_resp.data or []

    weighted_sum: list[float] | None = None
    total_weight = 0.0

    for artist in artists:
        artist_id = artist.get("id")
        if artist_id is None:
            continue

        vector = _parse_vector(artist.get("embedding"))
        if not vector:
            continue

        weight = artist_weights.get(int(artist_id), 0.0)
        if weight <= 0:
            continue

        if weighted_sum is None:
            weighted_sum = [0.0 for _ in vector]

        if len(weighted_sum) != len(vector):
            # Ignore inconsistent dimensions instead of crashing request flow.
            continue

        for i, val in enumerate(vector):
            weighted_sum[i] += val * weight
        total_weight += weight

    if not weighted_sum or total_weight == 0:
        return []

    return [val / total_weight for val in weighted_sum]


def rank_candidates(
    client: Client,
    user_id: str,
    taste_vector: list[float],
    prompt_vector: list[float] | None,
    weights: dict[str, float],
    exclude_library: bool,
    limit: int,
) -> list[dict]:
    artist_weights = _get_user_artist_weights(client, user_id)
    library_artist_ids = set(artist_weights.keys())

    artists_resp = (
        client.table("artists")
        .select("id,name,embedding,popularity")
        .execute()
    )
    candidates = artists_resp.data or []

    source_resp = client.table("sources").select("id,trust_weight").execute()
    source_weights = {
        int(row["id"]): float(row.get("trust_weight") or 0.7)
        for row in (source_resp.data or [])
        if row.get("id") is not None
    }

    mention_resp = (
        client.table("mentions")
        .select("artist_id,source_id,embedding,published_at,sentiment")
        .execute()
    )
    mentions = mention_resp.data or []

    mentions_by_artist: dict[int, list[dict]] = defaultdict(list)
    for m in mentions:
        artist_id = m.get("artist_id")
        if artist_id is None:
            continue
        mentions_by_artist[int(artist_id)].append(m)

    now = datetime.now(timezone.utc)
    recent_window_days = 45

    scored: list[dict] = []

    for artist in candidates:
        artist_id = artist.get("id")
        if artist_id is None:
            continue

        artist_id = int(artist_id)

        if exclude_library and artist_id in library_artist_ids:
            continue

        candidate_vec = _parse_vector(artist.get("embedding"))
        if not candidate_vec:
            continue

        affinity_raw = _cosine_similarity(taste_vector, candidate_vec)
        affinity = _normalize_01(affinity_raw)

        artist_mentions = mentions_by_artist.get(artist_id, [])
        context_scores: list[float] = []
        editorial_components: list[float] = []

        for mention in artist_mentions:
            mention_vec = _parse_vector(mention.get("embedding"))
            if prompt_vector and mention_vec:
                context_scores.append(_normalize_01(_cosine_similarity(prompt_vector, mention_vec)))

            published_at_raw = mention.get("published_at")
            recency_multiplier = 0.2
            if published_at_raw:
                try:
                    published_at = datetime.fromisoformat(published_at_raw.replace("Z", "+00:00"))
                    age_days = max((now - published_at).days, 0)
                    recency_multiplier = max(0.2, 1.0 - (age_days / recent_window_days))
                except ValueError:
                    recency_multiplier = 0.2

            trust = source_weights.get(int(mention.get("source_id") or 0), 0.7)
            sentiment = float(mention.get("sentiment") or 0.5)
            sentiment_factor = max(0.0, min(1.0, sentiment))
            editorial_components.append(trust * recency_multiplier * (0.5 + 0.5 * sentiment_factor))

        context = max(context_scores) if context_scores else 0.0
        editorial = min(1.0, sum(editorial_components) / max(len(editorial_components), 1))

        final_score = (
            weights["affinity"] * affinity
            + weights["context"] * context
            + weights["editorial"] * editorial
        )

        reasons = []
        if affinity > 0.55:
            reasons.append("High similarity to your listening profile")
        if context > 0.55:
            reasons.append("Strong match to your current prompt context")
        if editorial > 0.45:
            reasons.append("Recent trusted editorial momentum")
        if not reasons:
            reasons.append("Balanced across affinity, context, and editorial signals")

        scored.append(
            {
                "artist_id": str(artist_id),
                "artist_name": artist.get("name") or "Unknown artist",
                "score": round(final_score, 4),
                "signals": {
                    "affinity": round(affinity, 4),
                    "context": round(context, 4),
                    "editorial": round(editorial, 4),
                },
                "reasons": reasons,
            }
        )

    scored.sort(key=lambda row: row["score"], reverse=True)
    return scored[: max(limit, 0)]
