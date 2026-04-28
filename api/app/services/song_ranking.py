"""Song-level recommendation engine.

Extends the artist-level ranking to produce individual song recommendations.
Uses artist embeddings as the foundation, then ranks individual tracks by
combining artist-level signals with track-specific metadata:

  song_score = artist_score × track_boost

Where track_boost incorporates:
  - Track popularity (Spotify's 0–100 normalized)
  - Recency bonus for recently released/played tracks
  - Explicit preference alignment
  - Familiarity penalty (reduce songs from the user's own library)

Results are deduplicated by track name (case-insensitive) and diversity-reranked.
"""

from __future__ import annotations

import math
import random
from collections import Counter, defaultdict
from datetime import datetime, timezone

from supabase import Client

from app.services.ranking import (
    _cosine_similarity,
    _diversity_rerank,
    _get_previously_recommended_artist_ids,
    _get_user_artist_weights,
    _normalize_01,
    _parse_vector,
    _percentile_rank,
    build_taste_vector,
)


def recommend_songs(
    client: Client,
    user_id: str,
    taste_vector: list[float],
    prompt_vector: list[float] | None,
    weights: dict[str, float],
    exclude_library: bool,
    limit: int,
    prompt: str | None = None,
) -> list[dict]:
    """Return a ranked list of song-level recommendations."""

    artist_weights = _get_user_artist_weights(client, user_id)
    library_artist_ids = set(artist_weights.keys())
    previously_recommended = _get_previously_recommended_artist_ids(client, user_id)

    # ── Fetch all artists with embeddings ─────────────────────
    artists_resp = (
        client.table("artists")
        .select("id,name,embedding,popularity,genres,spotify_artist_id")
        .not_.is_("embedding", "null")
        .execute()
    )
    all_artists = artists_resp.data or []

    # ── Fetch user's track data for familiarity detection ─────
    user_tracks_resp = (
        client.table("user_tracks")
        .select("track_id,play_count,last_played_at")
        .eq("user_id", user_id)
        .execute()
    )
    user_track_map: dict[int, dict] = {
        row["track_id"]: row
        for row in (user_tracks_resp.data or [])
        if row.get("track_id")
    }

    # ── Source/mention data for editorial + context signals ────
    candidate_ids = [int(a["id"]) for a in all_artists if a.get("id")]

    source_resp = client.table("sources").select("id,name,trust_weight").execute()
    source_info: dict[int, dict] = {
        int(row["id"]): {
            "trust_weight": float(row.get("trust_weight") or 0.7),
            "name": row.get("name") or "",
        }
        for row in (source_resp.data or [])
        if row.get("id") is not None
    }

    if candidate_ids:
        mention_resp = (
            client.table("mentions")
            .select("artist_id,source_id,embedding,published_at,sentiment,excerpt")
            .in_("artist_id", candidate_ids)
            .execute()
        )
    else:
        mention_resp = type("_R", (), {"data": []})()  # type: ignore
    mentions_by_artist: dict[int, list[dict]] = defaultdict(list)
    for m in (mention_resp.data or []):
        aid = m.get("artist_id")
        if aid is not None:
            mentions_by_artist[int(aid)].append(m)

    now = datetime.now(timezone.utc)
    recent_window_days = 45

    effective_prompt_vector = prompt_vector if prompt_vector else taste_vector
    has_explicit_prompt = prompt_vector is not None

    # Keep original prompt text for audio feature matching
    _prompt_text = prompt

    # ── Phase 1: Score each artist (same as artist-level engine) ─
    raw_affinities: list[tuple[dict, float]] = []
    for artist in all_artists:
        aid = artist.get("id")
        if aid is None:
            continue
        aid = int(aid)
        if exclude_library and aid in library_artist_ids:
            continue
        vec = _parse_vector(artist.get("embedding"))
        if not vec:
            continue
        raw = _cosine_similarity(taste_vector, vec)
        raw_affinities.append((artist, raw))

    raw_vals = [r for _, r in raw_affinities]
    pct_ranks = _percentile_rank(raw_vals)

    EXPLORATION_STRENGTH = 0.06

    artist_scores: dict[int, dict] = {}
    for idx, (artist, affinity_raw) in enumerate(raw_affinities):
        aid = int(artist["id"])
        affinity = pct_ranks[idx] if pct_ranks else _normalize_01(affinity_raw)

        artist_mentions = mentions_by_artist.get(aid, [])
        context_scores: list[float] = []
        editorial_components: list[float] = []
        best_mention: dict | None = None
        best_mention_score = -1.0

        for mention in artist_mentions:
            mvec = _parse_vector(mention.get("embedding"))
            if effective_prompt_vector and mvec:
                context_scores.append(
                    _normalize_01(_cosine_similarity(effective_prompt_vector, mvec))
                )
            pub_raw = mention.get("published_at")
            recency_mult = 0.2
            if pub_raw:
                try:
                    pub_dt = datetime.fromisoformat(pub_raw.replace("Z", "+00:00"))
                    age = max((now - pub_dt).days, 0)
                    recency_mult = max(0.2, 1.0 - (age / recent_window_days))
                except ValueError:
                    recency_mult = 0.2

            src_id = int(mention.get("source_id") or 0)
            src = source_info.get(src_id, {"trust_weight": 0.7, "name": ""})
            sentiment = max(0.0, min(1.0, float(mention.get("sentiment") or 0.5)))
            component = src["trust_weight"] * recency_mult * (0.5 + 0.5 * sentiment)
            editorial_components.append(component)

            if component > best_mention_score and mention.get("excerpt"):
                best_mention_score = component
                best_mention = {
                    "source": src["name"],
                    "excerpt": mention.get("excerpt"),
                    "published_at": pub_raw,
                }

        context = max(context_scores) if context_scores else 0.0
        editorial = min(1.0, sum(editorial_components) / max(len(editorial_components), 1))

        base_score = (
            weights["affinity"] * affinity
            + weights["context"] * context
            + weights["editorial"] * editorial
        )

        if aid in previously_recommended:
            base_score *= 0.65

        artist_scores[aid] = {
            "base_score": base_score,
            "affinity": affinity,
            "context": context,
            "editorial": editorial,
            "name": artist.get("name") or "Unknown",
            "genres": list(artist.get("genres") or []),
            "best_mention": best_mention,
            "mention_count": len(artist_mentions),
            "spotify_artist_id": artist.get("spotify_artist_id"),
        }

    # ── Phase 2: Fetch tracks for top artists ────────────────────
    # Only expand songs for the top N artists to keep API calls manageable.
    top_artist_ids = sorted(
        artist_scores.keys(),
        key=lambda a: artist_scores[a]["base_score"],
        reverse=True,
    )[: limit * 4]  # Expand more artists than needed for diversity

    if not top_artist_ids:
        return []

    # Get tracks from DB for these artists (include audio features)
    tracks_resp = (
        client.table("tracks")
        .select("id,name,artist_id,album_name,duration_ms,popularity,spotify_track_id,explicit,energy,danceability,valence,tempo,acousticness,instrumentalness,speechiness")
        .in_("artist_id", top_artist_ids)
        .execute()
    )
    all_tracks = tracks_resp.data or []

    # Build the user's average audio profile from their library tracks
    user_audio_profile = _build_user_audio_profile(client, user_id)

    # Group tracks by artist
    tracks_by_artist: dict[int, list[dict]] = defaultdict(list)
    for t in all_tracks:
        aid = t.get("artist_id")
        if aid is not None:
            tracks_by_artist[int(aid)].append(t)

    # ── Phase 3: Score individual songs ──────────────────────────
    song_results: list[dict] = []
    seen_songs: set[str] = set()

    for aid in top_artist_ids:
        a_info = artist_scores.get(aid)
        if not a_info:
            continue

        tracks = tracks_by_artist.get(aid, [])
        if not tracks:
            continue

        # Sort tracks by popularity descending, take top 3 per artist
        # to avoid one artist flooding the results
        tracks.sort(key=lambda t: t.get("popularity") or 0, reverse=True)
        tracks = tracks[:3]

        for track in tracks:
            track_name = (track.get("name") or "").strip()
            dedup_key = f"{track_name.lower()}|{a_info['name'].lower()}"
            if dedup_key in seen_songs:
                continue
            seen_songs.add(dedup_key)

            track_id = track.get("id")
            track_pop = float(track.get("popularity") or 50) / 100.0

            # Track-level boost: popularity + audio feature match
            track_boost = 0.7 + (0.3 * track_pop)  # 0.7–1.0 range

            # Audio feature match bonus: if user has a taste profile and
            # the track has audio features, reward tracks that match
            audio_match = _audio_feature_match(
                track, user_audio_profile, has_explicit_prompt, _prompt_text
            )
            if audio_match > 0:
                track_boost *= (1.0 + audio_match * 0.25)  # Up to 25% boost

            # Familiarity: penalize songs already in user's library
            in_library = track_id in user_track_map if track_id else False
            if in_library and exclude_library:
                continue  # Skip entirely
            elif in_library:
                track_boost *= 0.5  # Heavy penalty if not excluded

            # Exploration
            exploration = random.uniform(-EXPLORATION_STRENGTH, EXPLORATION_STRENGTH)

            final_score = a_info["base_score"] * track_boost + exploration

            # Build reasons
            reasons = []
            if a_info["affinity"] > 0.55:
                reasons.append("Matches your taste")
            if a_info["context"] > 0.55:
                reasons.append("Matches your search" if has_explicit_prompt else "Fits your vibe")
            if a_info["editorial"] > 0.45:
                src_name = (
                    a_info["best_mention"]["source"]
                    if a_info["best_mention"] and a_info["best_mention"].get("source")
                    else ""
                )
                reasons.append(f"Featured in {src_name}" if src_name else "In the press")
            if track_pop > 0.7:
                reasons.append("Popular track")
            if audio_match > 0.6:
                reasons.append("Matches your sound")
            if not reasons:
                reasons.append("Curated pick")

            song_results.append({
                "track_id": str(track_id) if track_id else None,
                "track_name": track_name,
                "artist_id": str(aid),
                "artist_name": a_info["name"],
                "album_name": track.get("album_name") or "",
                "duration_ms": track.get("duration_ms") or 0,
                "explicit": track.get("explicit") or False,
                "spotify_track_id": track.get("spotify_track_id") or "",
                "score": round(max(0.0, final_score), 4),
                "signals": {
                    "affinity": round(a_info["affinity"], 4),
                    "context": round(a_info["context"], 4),
                    "editorial": round(a_info["editorial"], 4),
                    "track_popularity": round(track_pop, 4),
                    "audio_match": round(audio_match, 4),
                },
                "genres": a_info["genres"],
                "reasons": reasons,
                "mention_count": a_info["mention_count"],
                "top_mention": a_info["best_mention"],
            })

    # Sort by score
    song_results.sort(key=lambda s: s["score"], reverse=True)

    # ── Genre diversity re-ranking ───────────────────────────────
    diverse = _song_diversity_rerank(song_results, max(limit, 0))

    return diverse


def _song_diversity_rerank(scored: list[dict], limit: int) -> list[dict]:
    """Re-rank songs for genre + artist diversity."""
    if len(scored) <= limit:
        return scored

    pool = scored[: limit * 3]
    selected: list[dict] = []
    genre_counts: Counter[str] = Counter()
    artist_counts: Counter[str] = Counter()
    used: set[str] = set()

    MAX_GENRE_FRACTION = 0.3
    MAX_ARTIST_SONGS = 2  # At most 2 songs per artist in final results

    while len(selected) < limit and pool:
        best_idx = -1
        best_adjusted = -1.0

        for i, candidate in enumerate(pool):
            key = f"{candidate['track_name']}|{candidate['artist_name']}".lower()
            if key in used:
                continue

            base = candidate["score"]
            genres = candidate.get("genres") or []
            primary_genre = genres[0].lower() if genres else "__none__"
            artist = candidate["artist_name"].lower()

            # Artist cap
            if artist_counts.get(artist, 0) >= MAX_ARTIST_SONGS:
                continue

            # Genre diversity penalty
            genre_share = genre_counts.get(primary_genre, 0) / max(len(selected), 1)
            penalty = 0.7 if genre_share >= MAX_GENRE_FRACTION else 1.0

            adjusted = base * penalty
            if adjusted > best_adjusted:
                best_adjusted = adjusted
                best_idx = i

        if best_idx < 0:
            break

        pick = pool[best_idx]
        key = f"{pick['track_name']}|{pick['artist_name']}".lower()
        selected.append(pick)
        used.add(key)

        genres = pick.get("genres") or []
        primary_genre = genres[0].lower() if genres else "__none__"
        genre_counts[primary_genre] += 1
        artist_counts[pick["artist_name"].lower()] += 1

    return selected


# ── Audio feature helpers ────────────────────────────────────────

# Keywords in prompts that map to audio feature preferences.
# Each keyword maps to {feature: target_value} pairs.
_MOOD_KEYWORDS: dict[str, dict[str, float]] = {
    "chill": {"energy": 0.3, "valence": 0.4, "tempo": 90},
    "relaxing": {"energy": 0.2, "valence": 0.4, "acousticness": 0.7},
    "calm": {"energy": 0.2, "valence": 0.4, "acousticness": 0.6},
    "lo-fi": {"energy": 0.3, "acousticness": 0.5, "instrumentalness": 0.5},
    "lofi": {"energy": 0.3, "acousticness": 0.5, "instrumentalness": 0.5},
    "energetic": {"energy": 0.85, "danceability": 0.7, "tempo": 130},
    "hype": {"energy": 0.9, "danceability": 0.8, "valence": 0.7},
    "party": {"energy": 0.8, "danceability": 0.85, "valence": 0.7},
    "dance": {"danceability": 0.85, "energy": 0.75, "tempo": 120},
    "workout": {"energy": 0.85, "tempo": 140, "danceability": 0.6},
    "gym": {"energy": 0.9, "tempo": 140},
    "sad": {"valence": 0.2, "energy": 0.3},
    "melancholy": {"valence": 0.2, "energy": 0.3, "acousticness": 0.5},
    "happy": {"valence": 0.8, "energy": 0.7},
    "upbeat": {"valence": 0.75, "energy": 0.75, "tempo": 120},
    "acoustic": {"acousticness": 0.8, "instrumentalness": 0.3},
    "instrumental": {"instrumentalness": 0.8},
    "focus": {"energy": 0.4, "instrumentalness": 0.5, "speechiness": 0.05},
    "study": {"energy": 0.3, "instrumentalness": 0.5, "speechiness": 0.05},
    "sleep": {"energy": 0.15, "acousticness": 0.7, "instrumentalness": 0.5},
    "slow": {"tempo": 75, "energy": 0.3},
    "fast": {"tempo": 140, "energy": 0.8},
    "dark": {"valence": 0.2, "energy": 0.5},
    "aggressive": {"energy": 0.9, "valence": 0.3},
    "intense": {"energy": 0.85, "loudness": -5},
    "summer": {"valence": 0.75, "energy": 0.7, "danceability": 0.7},
    "road trip": {"energy": 0.65, "valence": 0.65},
    "late night": {"energy": 0.35, "valence": 0.35, "acousticness": 0.4},
    "morning": {"energy": 0.5, "valence": 0.6, "acousticness": 0.5},
}

# Feature normalization ranges for computing distance
_FEATURE_RANGES: dict[str, tuple[float, float]] = {
    "energy": (0.0, 1.0),
    "danceability": (0.0, 1.0),
    "valence": (0.0, 1.0),
    "acousticness": (0.0, 1.0),
    "instrumentalness": (0.0, 1.0),
    "speechiness": (0.0, 1.0),
    "tempo": (40.0, 200.0),
    "loudness": (-60.0, 0.0),
}


def _build_user_audio_profile(
    client: Client, user_id: str
) -> dict[str, float] | None:
    """Build the user's average audio feature profile from their library.

    Returns a dict like {"energy": 0.65, "valence": 0.55, ...} or None
    if no audio features are available.
    """
    try:
        # Get the user's track IDs
        ut_resp = (
            client.table("user_tracks")
            .select("track_id,play_count")
            .eq("user_id", user_id)
            .execute()
        )
        user_tracks = ut_resp.data or []
        if not user_tracks:
            return None

        track_ids = [row["track_id"] for row in user_tracks if row.get("track_id")]
        if not track_ids:
            return None

        # Fetch audio features for these tracks
        tracks_resp = (
            client.table("tracks")
            .select("id,energy,danceability,valence,tempo,acousticness,instrumentalness,speechiness,loudness")
            .in_("id", track_ids)
            .not_.is_("energy", "null")
            .execute()
        )
        tracks_with_features = tracks_resp.data or []
        if not tracks_with_features:
            return None

        # Build play_count map for weighting
        play_map = {row["track_id"]: max(row.get("play_count") or 1, 1) for row in user_tracks}

        features = ["energy", "danceability", "valence", "tempo", "acousticness",
                     "instrumentalness", "speechiness", "loudness"]
        weighted_sums: dict[str, float] = {f: 0.0 for f in features}
        total_weight = 0.0

        for t in tracks_with_features:
            w = float(play_map.get(t["id"], 1))
            for f in features:
                val = t.get(f)
                if val is not None:
                    weighted_sums[f] += float(val) * w
            total_weight += w

        if total_weight == 0:
            return None

        return {f: weighted_sums[f] / total_weight for f in features}

    except Exception as exc:
        print(f"song_ranking: failed to build user audio profile: {exc}")
        return None


def _audio_feature_match(
    track: dict,
    user_profile: dict[str, float] | None,
    has_prompt: bool,
    prompt_text: str | None,
) -> float:
    """Score how well a track's audio features match the user's taste and/or prompt.

    Returns 0.0–1.0 where higher = better match.
    Returns 0.0 if the track has no audio features.
    """
    # Check if track has audio features at all
    if track.get("energy") is None:
        return 0.0

    scores: list[float] = []

    # 1. Match against user's audio profile (if available)
    if user_profile:
        profile_match = _feature_distance_score(track, user_profile)
        scores.append(profile_match)

    # 2. Match against prompt keywords (if a prompt was given)
    if has_prompt and prompt_text:
        prompt_targets = _extract_prompt_targets(prompt_text)
        if prompt_targets:
            prompt_match = _feature_distance_score(track, prompt_targets)
            # Weight prompt match more heavily when a prompt is given
            scores.append(prompt_match * 1.3)

    if not scores:
        return 0.0

    return min(1.0, sum(scores) / len(scores))


def _feature_distance_score(track: dict, targets: dict[str, float]) -> float:
    """Score based on how close the track's features are to target values.

    Returns 0.0–1.0 where 1.0 = perfect match.
    """
    if not targets:
        return 0.0

    distances: list[float] = []
    for feature, target in targets.items():
        actual = track.get(feature)
        if actual is None:
            continue

        lo, hi = _FEATURE_RANGES.get(feature, (0.0, 1.0))
        range_size = hi - lo
        if range_size <= 0:
            continue

        normalized_dist = abs(float(actual) - target) / range_size
        # Convert distance to similarity (0 = far, 1 = close)
        similarity = max(0.0, 1.0 - normalized_dist)
        distances.append(similarity)

    if not distances:
        return 0.0

    return sum(distances) / len(distances)


def _extract_prompt_targets(prompt: str) -> dict[str, float]:
    """Extract audio feature targets from natural language prompt."""
    prompt_lower = prompt.lower()
    combined: dict[str, list[float]] = {}

    for keyword, targets in _MOOD_KEYWORDS.items():
        if keyword in prompt_lower:
            for feature, value in targets.items():
                combined.setdefault(feature, []).append(value)

    if not combined:
        return {}

    # Average when multiple keywords target the same feature
    return {f: sum(vals) / len(vals) for f, vals in combined.items()}
