"""Ranking primitives for recommendation generation.

The implementation is intentionally Python-first while schema and SQL RPCs
settle. It uses Supabase reads and computes the blend in-process.

v2 improvements:
  - Random exploration factor for varied results each run
  - "Already seen" deprioritization (artists in saved playlists)
  - Mood signal fallback: taste vector → mention embeddings when no prompt
  - Genre diversity re-ranking to avoid top-heavy genre clusters
"""

from __future__ import annotations

import math
import random
from collections import Counter, defaultdict
from datetime import datetime, timezone

from supabase import Client


# ── Vector utilities ─────────────────────────────────────────────

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


def _percentile_rank(values: list[float]) -> list[float]:
    """Return percentile ranks (0.0–1.0) for a list of raw scores.

    This spreads clustered scores across the full range so the UI
    shows meaningful differences even when raw cosine similarities
    are all bunched around 0.85.
    """
    if not values:
        return []
    n = len(values)
    if n == 1:
        return [1.0]
    indexed = sorted(enumerate(values), key=lambda t: t[1])
    ranks = [0.0] * n
    for rank_pos, (orig_idx, _) in enumerate(indexed):
        ranks[orig_idx] = rank_pos / (n - 1)
    return ranks


# ── Data helpers ─────────────────────────────────────────────────

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


def _get_previously_recommended_artist_ids(client: Client, user_id: str) -> set[int]:
    """Return artist IDs that appear in any of the user's saved playlists."""
    try:
        playlists_resp = (
            client.table("playlists")
            .select("id")
            .eq("user_id", user_id)
            .execute()
        )
        playlist_ids = [row["id"] for row in (playlists_resp.data or []) if row.get("id")]
        if not playlist_ids:
            return set()

        items_resp = (
            client.table("playlist_items")
            .select("artist_id")
            .in_("playlist_id", playlist_ids)
            .not_.is_("artist_id", "null")
            .execute()
        )
        return {int(row["artist_id"]) for row in (items_resp.data or []) if row.get("artist_id")}
    except Exception:
        # If the playlists tables don't exist yet, just skip.
        return set()


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
            continue

        for i, val in enumerate(vector):
            weighted_sum[i] += val * weight
        total_weight += weight

    if not weighted_sum or total_weight == 0:
        return []

    return [val / total_weight for val in weighted_sum]


# ── Diversity re-ranking ─────────────────────────────────────────

def _diversity_rerank(scored: list[dict], limit: int) -> list[dict]:
    """Re-rank to ensure genre diversity in the top results.

    Greedy selection: pick the best remaining candidate, but penalize
    artists whose primary genre is already well-represented in the
    selected set. This prevents the top 10 from all being the same genre.
    """
    if len(scored) <= limit:
        return scored

    # Work with a larger pool so we have room to diversify.
    pool = scored[: limit * 3]
    selected: list[dict] = []
    genre_counts: Counter[str] = Counter()
    used_ids: set[str] = set()

    # Maximum fraction of results from a single genre before penalty kicks in.
    MAX_GENRE_FRACTION = 0.3

    while len(selected) < limit and pool:
        best_idx = -1
        best_adjusted = -1.0

        for i, candidate in enumerate(pool):
            if candidate["artist_id"] in used_ids:
                continue

            base_score = candidate["score"]
            genres = candidate.get("genres") or []
            primary_genre = genres[0].lower() if genres else "__none__"

            # Penalty: if this genre already fills >MAX_GENRE_FRACTION of
            # selected slots, scale down the score.
            genre_share = genre_counts.get(primary_genre, 0) / max(len(selected), 1)
            penalty = 1.0
            if genre_share >= MAX_GENRE_FRACTION:
                penalty = 0.7  # 30% score reduction

            adjusted = base_score * penalty
            if adjusted > best_adjusted:
                best_adjusted = adjusted
                best_idx = i

        if best_idx < 0:
            break

        pick = pool[best_idx]
        selected.append(pick)
        used_ids.add(pick["artist_id"])

        genres = pick.get("genres") or []
        primary_genre = genres[0].lower() if genres else "__none__"
        genre_counts[primary_genre] += 1

    return selected


# ── Main ranking function ────────────────────────────────────────

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
    previously_recommended = _get_previously_recommended_artist_ids(client, user_id)

    artists_resp = (
        client.table("artists")
        .select("id,name,embedding,popularity,genres,spotify_artist_id")
        .not_.is_("embedding", "null")
        .execute()
    )
    candidates = artists_resp.data or []

    # Collect candidate artist ids so we only fetch relevant mentions.
    candidate_ids = [
        int(a["id"]) for a in candidates if a.get("id") is not None
    ]

    source_resp = client.table("sources").select("id,name,trust_weight").execute()
    source_info: dict[int, dict] = {
        int(row["id"]): {
            "trust_weight": float(row.get("trust_weight") or 0.7),
            "name": row.get("name") or "",
        }
        for row in (source_resp.data or [])
        if row.get("id") is not None
    }

    # Only fetch mentions for artists in the candidate pool, not all mentions.
    if candidate_ids:
        mention_resp = (
            client.table("mentions")
            .select("artist_id,source_id,embedding,published_at,sentiment,excerpt")
            .in_("artist_id", candidate_ids)
            .execute()
        )
    else:
        mention_resp = type("_R", (), {"data": []})()  # type: ignore[assignment]
    mentions = mention_resp.data or []

    mentions_by_artist: dict[int, list[dict]] = defaultdict(list)
    for m in mentions:
        artist_id = m.get("artist_id")
        if artist_id is None:
            continue
        mentions_by_artist[int(artist_id)].append(m)

    now = datetime.now(timezone.utc)
    recent_window_days = 45

    # ── Mood fallback: when no prompt, use taste vector for context ──
    # This makes the "Mood" slider meaningful even without a search query.
    # Instead of being 0 for everyone, it measures how well each artist's
    # editorial coverage aligns with your overall listening taste.
    effective_prompt_vector = prompt_vector if prompt_vector else taste_vector
    has_explicit_prompt = prompt_vector is not None

    # ── Phase 1: compute raw affinity for all candidates ─────────
    raw_affinities: list[tuple[dict, float]] = []
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
        raw = _cosine_similarity(taste_vector, candidate_vec)
        raw_affinities.append((artist, raw))

    # Percentile-rank the affinity scores so they spread 0–100% instead
    # of clustering around 86%.
    raw_vals = [r for _, r in raw_affinities]
    pct_ranks = _percentile_rank(raw_vals)

    scored: list[dict] = []
    seen_names: set[str] = set()  # deduplicate by lowercase artist name

    # ── Exploration: controlled randomness ───────────────────────
    # Each run gets slightly different results. The exploration factor
    # is small enough to not overwhelm good matches, but large enough
    # to shuffle mid-tier candidates around.
    EXPLORATION_STRENGTH = 0.08  # ±8% random nudge on final score

    for idx, (artist, affinity_raw) in enumerate(raw_affinities):
        artist_id = int(artist["id"])
        name_lower = (artist.get("name") or "").strip().lower()
        if name_lower in seen_names:
            continue
        seen_names.add(name_lower)

        affinity = pct_ranks[idx] if pct_ranks else _normalize_01(affinity_raw)
        artist_mentions = mentions_by_artist.get(artist_id, [])
        context_scores: list[float] = []
        editorial_components: list[float] = []
        best_mention: dict | None = None
        best_mention_score: float = -1.0

        for mention in artist_mentions:
            mention_vec = _parse_vector(mention.get("embedding"))
            if effective_prompt_vector and mention_vec:
                context_scores.append(
                    _normalize_01(_cosine_similarity(effective_prompt_vector, mention_vec))
                )

            published_at_raw = mention.get("published_at")
            recency_multiplier = 0.2
            if published_at_raw:
                try:
                    published_at = datetime.fromisoformat(published_at_raw.replace("Z", "+00:00"))
                    age_days = max((now - published_at).days, 0)
                    recency_multiplier = max(0.2, 1.0 - (age_days / recent_window_days))
                except ValueError:
                    recency_multiplier = 0.2

            src_id = int(mention.get("source_id") or 0)
            src = source_info.get(src_id, {"trust_weight": 0.7, "name": ""})
            trust = src["trust_weight"]
            sentiment = float(mention.get("sentiment") or 0.5)
            sentiment_factor = max(0.0, min(1.0, sentiment))
            component = trust * recency_multiplier * (0.5 + 0.5 * sentiment_factor)
            editorial_components.append(component)

            if component > best_mention_score and mention.get("excerpt"):
                best_mention_score = component
                best_mention = {
                    "source": src["name"],
                    "excerpt": mention.get("excerpt"),
                    "published_at": published_at_raw,
                }

        context = max(context_scores) if context_scores else 0.0
        editorial = min(1.0, sum(editorial_components) / max(len(editorial_components), 1))

        # Tiny popularity tiebreaker (0–0.02) to differentiate artists
        # that would otherwise have identical scores.
        pop = float(artist.get("popularity") or 0) / 100.0
        tiebreaker = pop * 0.02

        final_score = (
            weights["affinity"] * affinity
            + weights["context"] * context
            + weights["editorial"] * editorial
            + tiebreaker
        )

        # ── "From your library" penalty ──────────────────────────
        # Artists already in the user's listening library get a soft
        # reduction so familiar names don't dominate Discover. Applied
        # BEFORE the previously_recommended penalty so the two compose
        # multiplicatively for artists that fall into both buckets.
        if artist_id in library_artist_ids:
            final_score *= 0.85  # 15% penalty

        # ── "Already seen" penalty ───────────────────────────────
        # Artists already in user's playlists get a score reduction.
        # They can still appear, just lower ranked — keeps things fresh.
        if artist_id in previously_recommended:
            final_score *= 0.65  # 35% penalty

        # ── Exploration factor ───────────────────────────────────
        # Random nudge so each run produces different ordering,
        # especially among similarly-scored candidates.
        exploration = random.uniform(-EXPLORATION_STRENGTH, EXPLORATION_STRENGTH)
        final_score += exploration

        reasons = []
        if affinity > 0.55:
            reasons.append("Matches your taste")
        if context > 0.55:
            if has_explicit_prompt:
                reasons.append("Matches your search")
            else:
                reasons.append("Fits your vibe")
        if editorial > 0.45:
            src_name = best_mention["source"] if best_mention and best_mention.get("source") else ""
            reasons.append(f"Featured in {src_name}" if src_name else "In the press")
        if artist_id in library_artist_ids:
            reasons.append("From your library")
        if artist_id in previously_recommended:
            reasons.append("Previously saved")
        if not reasons:
            reasons.append("Curated pick")

        scored.append(
            {
                "artist_id": str(artist_id),
                "artist_name": artist.get("name") or "Unknown artist",
                "spotify_artist_id": artist.get("spotify_artist_id"),
                "score": round(max(0.0, final_score), 4),
                "signals": {
                    "affinity": round(affinity, 4),
                    "context": round(context, 4),
                    "editorial": round(editorial, 4),
                },
                "genres": list(artist.get("genres") or []),
                "mention_count": len(artist_mentions),
                "top_mention": best_mention,
                "reasons": reasons,
            }
        )

    scored.sort(key=lambda row: row["score"], reverse=True)

    # ── Genre diversity re-ranking ───────────────────────────────
    # Greedy selection that penalizes over-represented genres in top N.
    diverse_results = _diversity_rerank(scored, max(limit, 0))

    return diverse_results
