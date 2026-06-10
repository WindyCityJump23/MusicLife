"""Pure scoring, lane-classification, and strategy helpers for song ranking.

Extracted from ``song_ranking.py`` so the stateless math — lane assignment,
novelty/deep-cut scoring, prompt classification, taste-strategy normalization,
and lane-quota targets — can be unit-tested in isolation and reused without
pulling in the 1,300-line orchestrator. Nothing here touches the database; all
functions are deterministic given their arguments.
"""

from __future__ import annotations

from datetime import datetime

DISCOVERY_LANES = ("deep_cuts", "popular", "radio_hits")
DEFAULT_DISCOVERY_MIX = {"deep_cuts": 38.0, "popular": 38.0, "radio_hits": 24.0}

_AUDIO_DIMENSION_WEIGHTS = {
    "energy": 1.5,
    "valence": 1.3,
    "danceability": 1.0,
    "acousticness": 0.8,
    "instrumentalness": 0.7,
}
_AUDIO_DIM_WEIGHT_TOTAL = sum(_AUDIO_DIMENSION_WEIGHTS.values())

_GENRE_PHRASES = {
    "alternative rock",
    "hip hop",
    "hip-hop",
    "r&b",
    "rnb",
    "indie rock",
    "indie pop",
    "electronic",
    "edm",
    "dance",
    "house",
    "techno",
    "trance",
    "dubstep",
    "drum and bass",
    "dnb",
    "ambient",
    "jazz",
    "metal",
    "punk",
    "folk",
    "country",
    "americana",
    "soul",
    "funk",
    "classical",
    "reggae",
    "reggaeton",
    "latin",
    "pop",
    "rock",
    "rap",
    "trap",
    "lo-fi",
    "lofi",
    "grunge",
    "blues",
    "gospel",
    "disco",
    "synthwave",
    "synth pop",
}

_GENRE_TOKEN_STOPWORDS = {
    "new",
    "old",
    "sad",
    "happy",
    "chill",
    "night",
    "drive",
    "work",
    "study",
    "songs",
    "music",
    "vibes",
    "like",
}

_GENRE_SYNONYMS: dict[str, list[str]] = {
    "edm": ["electronic", "dance"],
    "dnb": ["drum", "bass"],
    "lofi": ["lo", "fi"],
    "rnb": ["r&b"],
    "trap": ["hip", "hop"],
    "synthwave": ["synth", "electronic"],
    "grunge": ["alternative", "rock"],
    "disco": ["dance", "funk"],
}

_MOOD_WORDS = frozenset({
    "sad", "happy", "chill", "mellow", "upbeat", "energetic", "angry",
    "melancholy", "dreamy", "dark", "bright", "intense", "relaxing",
    "romantic", "nostalgic", "euphoric", "moody", "peaceful", "aggressive",
    "soothing", "hype", "calm", "somber", "joyful", "bittersweet",
    "anxious", "hopeful", "lonely", "party", "workout", "focus", "sleep",
    "study", "driving", "running", "cooking", "morning", "night", "rainy",
    "summer", "winter", "autumn", "spring", "beach", "road trip",
})

_CONTEXT_WORDS = frozenset({
    "new", "recent", "latest", "fresh", "upcoming", "underground",
    "obscure", "unknown", "local", "indie", "deep", "rare", "hidden",
})


def _genre_tokens_for_prompt(prompt_text: str | None) -> list[str] | None:
    if not prompt_text:
        return None
    normalized = prompt_text.strip().lower().replace("-", " ")
    normalized = " ".join(normalized.split())
    if not normalized:
        return None

    hits: list[str] = []
    for phrase in sorted(_GENRE_PHRASES, key=len, reverse=True):
        phrase_norm = phrase.replace("-", " ")
        if phrase_norm in normalized:
            hits.extend([tok for tok in phrase_norm.split() if tok not in _GENRE_TOKEN_STOPWORDS])
            synonyms = _GENRE_SYNONYMS.get(phrase_norm)
            if synonyms:
                hits.extend(synonyms)

    if not hits:
        return None

    deduped: list[str] = []
    seen: set[str] = set()
    for token in hits:
        if token and token not in seen:
            seen.add(token)
            deduped.append(token)
    return deduped or None


def _release_age_days(raw_release: object, now: datetime) -> int | None:
    if not raw_release:
        return None
    try:
        release_dt = datetime.fromisoformat(str(raw_release))
    except (ValueError, AttributeError):
        return None
    return max((now.date() - release_dt.date()).days, 0)


def _lane_for_track(
    track_pop: float,
    genres: list[str],
    reasons: list[str],
    editorial: float,
    release_age_days: int | None,
) -> str:
    reason_text = " ".join(reasons).lower()
    genre_text = " ".join(genres).lower()
    has_deep_signal = (
        "deep cut" in reason_text
        or "obscure" in reason_text
        or "indie" in genre_text
        or "underground" in genre_text
        or (editorial >= 0.45 and track_pop < 0.62)
    )
    is_newish = release_age_days is not None and release_age_days <= 540
    if has_deep_signal or track_pop < 0.46:
        return "deep_cuts"
    if track_pop >= 0.78 and not is_newish:
        return "radio_hits"
    return "popular"


def _deep_cut_quality(
    track_pop: float,
    artist_editorial: float,
    track_context: float,
    track_affinity: float,
    is_library_artist: bool,
    has_track_embedding: bool,
) -> float:
    """Score how good a deep cut candidate is, independent of popularity."""
    quality = 0.0
    quality += 0.30 * min(1.0, artist_editorial * 2.0)
    quality += 0.25 * track_affinity
    quality += 0.20 * track_context
    if is_library_artist:
        quality += 0.15
    if has_track_embedding:
        quality += 0.10
    return min(1.0, quality)


def _novelty_score(
    track_pop: float,
    editorial: float,
    in_library: bool,
    is_library_artist: bool,
    release_age_days: int | None,
) -> float:
    release_bonus = 0.0
    if release_age_days is not None and release_age_days < 365:
        release_bonus = 1.0 - release_age_days / 365
    score = (
        0.45 * (1.0 - track_pop)
        + 0.22 * editorial
        + 0.18 * (0.0 if is_library_artist else 1.0)
        + 0.15 * release_bonus
    )
    if in_library:
        score *= 0.35
    return max(0.0, min(1.0, score))


def classify_prompt(prompt_text: str) -> str:
    """Classify a prompt as 'genre', 'mood', or 'semantic'.

    genre  = matches known genre tokens, use genre filter + embedding
    mood   = mood/activity words, rely on embedding similarity only
    semantic = mixed or unclear, use embedding only
    """
    words = set(prompt_text.strip().lower().replace("-", " ").split())
    mood_hits = words & _MOOD_WORDS
    context_hits = words & _CONTEXT_WORDS
    non_stop = words - {"the", "a", "an", "and", "or", "for", "my", "me", "some", "like", "with", "in", "on", "of"}

    if not non_stop:
        return "semantic"

    mood_ratio = len(mood_hits | context_hits) / len(non_stop)
    if mood_ratio >= 0.5:
        return "mood"
    return "genre"


def _clean_strategy(taste_strategy: dict | None) -> dict:
    if not isinstance(taste_strategy, dict):
        return {}

    def _clean_list(value: object) -> list[str]:
        if not isinstance(value, list):
            return []
        cleaned: list[str] = []
        seen: set[str] = set()
        for item in value:
            text = str(item or "").strip().lower()
            if not text or text in seen:
                continue
            seen.add(text)
            cleaned.append(text[:48])
            if len(cleaned) >= 12:
                break
        return cleaned

    live = taste_strategy.get("live_expansion")
    freshness = taste_strategy.get("freshness")
    station_distance = taste_strategy.get("station_distance")
    familiarity = taste_strategy.get("familiarity")
    mix = taste_strategy.get("discovery_mix")
    if not isinstance(mix, dict):
        mix = {}

    def _mix_value(key: str) -> float:
        value = mix.get(key)
        if value is None:
            value = DEFAULT_DISCOVERY_MIX[key]
        try:
            return float(value)
        except (TypeError, ValueError):
            return DEFAULT_DISCOVERY_MIX[key]

    return {
        "genre_boosts": _clean_list(taste_strategy.get("genre_boosts")),
        "genre_avoids": _clean_list(taste_strategy.get("genre_avoids")),
        "discovery_mix": {
            "deep_cuts": _mix_value("deep_cuts"),
            "popular": _mix_value("popular"),
            "radio_hits": _mix_value("radio_hits"),
        },
        "station_distance": station_distance if station_distance in {"closer", "balanced", "further"} else "balanced",
        "familiarity": familiarity if familiarity in {"anchors", "balanced", "surprises"} else "balanced",
        "live_expansion": live if live in {"auto", "catalog", "live"} else "auto",
        "freshness": freshness if freshness in {"newer", "balanced", "timeless"} else "balanced",
    }


def _genre_strategy_multiplier(genres: list[str], strategy: dict) -> float:
    if not strategy:
        return 1.0
    genre_text = " ".join(g.lower() for g in genres)
    boosted = strategy.get("genre_boosts") or []
    avoided = strategy.get("genre_avoids") or []
    boost_hits = sum(1 for genre in boosted if genre and genre in genre_text)
    avoid_hits = sum(1 for genre in avoided if genre and genre in genre_text)
    multiplier = 1.0 + min(boost_hits, 3) * 0.08 - min(avoid_hits, 3) * 0.12
    return max(0.62, min(1.28, multiplier))


def _freshness_strategy_multiplier(release_age_days: int | None, track_pop: float, strategy: dict) -> float:
    freshness = strategy.get("freshness") if strategy else "balanced"
    if freshness == "newer":
        if release_age_days is not None and release_age_days <= 540:
            return 1.10
        if release_age_days is not None and release_age_days > 3650:
            return 0.94
    elif freshness == "timeless":
        if track_pop >= 0.68:
            return 1.06
        if release_age_days is not None and release_age_days <= 180:
            return 0.96
    return 1.0


def _assign_lane(
    track_pop: float,
    in_library: bool,
    is_library_artist: bool,
    editorial: float,
) -> str:
    if track_pop >= 0.72 and not in_library:
        return "radio_hits"
    if track_pop >= 0.48:
        return "popular"
    if track_pop <= 0.35 and not is_library_artist:
        return "deep_cuts"
    if is_library_artist and track_pop > 0.42:
        return "popular"
    if editorial > 0.3:
        return "popular"
    return "deep_cuts"


def _lane_targets(limit: int, strategy: dict | None = None) -> dict[str, int]:
    if limit <= 0:
        return {lane: 0 for lane in DISCOVERY_LANES}
    mix = (strategy or {}).get("discovery_mix") if strategy else None
    if isinstance(mix, dict):
        deep_pct = max(0.0, min(100.0, float(mix.get("deep_cuts") or 0.0)))
        popular_pct = max(0.0, min(100.0, float(mix.get("popular") or 0.0)))
        hits_pct = max(0.0, min(100.0, float(mix.get("radio_hits") or 0.0)))
        total = deep_pct + popular_pct + hits_pct
        if total > 0:
            radio_hits = max(0, round(limit * (hits_pct / total)))
            deep_cuts = max(0, round(limit * (deep_pct / total)))
            if limit >= 3:
                radio_hits = max(1, radio_hits)
                deep_cuts = max(1, deep_cuts)
            popular = max(0, limit - radio_hits - deep_cuts)
            return {
                "deep_cuts": deep_cuts,
                "popular": popular,
                "radio_hits": radio_hits,
            }

    radio_hits = max(1, round(limit * 0.18))
    deep_cuts = max(2, round(limit * 0.38))
    popular = max(0, limit - radio_hits - deep_cuts)
    return {
        "deep_cuts": deep_cuts,
        "popular": popular,
        "radio_hits": radio_hits,
    }


def _candidate_key(candidate: dict) -> str:
    return f"{(candidate.get('track_name') or '')}|{(candidate.get('artist_name') or '')}".lower()


# Favorites boost: only similarity above this floor counts as "near the
# user's favorites" — below it the boost is neutral so unrelated tracks are
# not lifted en masse.
_FAVORITES_SIM_FLOOR = 0.45
_FAVORITES_BOOST_MAX = 0.25
# Threshold for surfacing "close to your favorites" as a user-facing reason.
FAVORITES_REASON_THRESHOLD = 0.62


def _favorites_boost(similarity: float | None) -> float:
    """Multiplicative boost for tracks near the user's favorites centroid.

    Maps cosine similarity in [_FAVORITES_SIM_FLOOR, 1.0] linearly onto
    [1.0, 1.0 + _FAVORITES_BOOST_MAX]; anything at or below the floor (or an
    absent signal) is neutral 1.0. Monotonic and bounded so it can never
    dominate the affinity/editorial blend.
    """
    if similarity is None:
        return 1.0
    span = 1.0 - _FAVORITES_SIM_FLOOR
    above = max(0.0, min(1.0, similarity) - _FAVORITES_SIM_FLOOR)
    return 1.0 + _FAVORITES_BOOST_MAX * (above / span)
