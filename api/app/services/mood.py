"""Tag-based mood targeting.

Spotify's ``/audio-features`` endpoint was deprecated for new apps in
Nov 2024, so the energy/valence/danceability columns on ``tracks`` are
unpopulated. This module provides the same kind of mood signal using
data we *do* have: the Last.fm tags collected by the track tag backfill.

Each mood category is defined by a curated set of tag stems. When a
user's prompt mentions a mood word, we identify the target category
and score each track by how many of its tags overlap with that
category's tag set, normalized to ``[0, 1]``.

The signal is intentionally additive and small (capped contribution) —
it nudges mood-aligned tracks up without overpowering the vector or
BM25 components.
"""

from __future__ import annotations

# Mood categories. Keys are the canonical mood names; the ``triggers``
# set holds words that, when found in the prompt, activate the
# category, and ``tags`` is the Last.fm-tag vocabulary that
# characterizes the mood.
#
# A track's mood-fit for an active category is the fraction of its
# tags that fall in the category's tag set, capped at 1.0.

MOODS: dict[str, dict[str, set[str]]] = {
    "energetic": {
        "triggers": {
            "energetic", "energy", "high energy", "high-energy",
            "upbeat", "pumping", "intense", "hyped", "hype",
            "workout", "running", "gym", "pump up", "pumped",
        },
        "tags": {
            "upbeat", "energetic", "high energy", "high-energy",
            "pumping", "intense", "fast", "hard", "powerful",
            "workout", "running", "running music", "gym",
            "driving", "anthem", "epic", "loud",
        },
    },
    "chill": {
        "triggers": {
            "chill", "chilled", "relaxing", "relax", "mellow",
            "calm", "calming", "lo-fi", "lofi", "downtempo",
            "ambient", "soft", "soothing", "easy listening",
            "background", "study", "studying", "focus",
        },
        "tags": {
            "chill", "chilled", "chillout", "chill out",
            "mellow", "relaxing", "relax", "calm", "lo-fi",
            "lofi", "downtempo", "ambient", "soft", "soothing",
            "easy listening", "study", "background music",
            "smooth", "atmospheric", "dreamy",
        },
    },
    "happy": {
        "triggers": {
            "happy", "happiness", "uplifting", "cheerful",
            "joyful", "joy", "feel good", "feel-good",
            "summery", "summer", "bright", "sunny", "fun",
            "good vibes", "good mood",
        },
        "tags": {
            "happy", "uplifting", "cheerful", "joyful",
            "feel good", "feel-good", "summery", "summer",
            "bright", "sunny", "fun", "good vibes",
            "playful", "lighthearted", "positive",
        },
    },
    "sad": {
        "triggers": {
            "sad", "sadness", "melancholy", "melancholic",
            "depressing", "depressed", "heartbreak", "heartbroken",
            "breakup", "break-up", "moody", "dark",
            "lonely", "lonesome", "tearjerker", "crying",
        },
        "tags": {
            "sad", "melancholy", "melancholic", "depressing",
            "heartbreak", "heartbroken", "breakup", "moody",
            "dark", "lonely", "tearjerker", "somber",
            "wistful", "bittersweet", "emotional",
        },
    },
    "romantic": {
        "triggers": {
            "romantic", "romance", "love", "love song",
            "love songs", "intimate", "sensual", "sexy",
            "tender", "passionate", "date night", "valentine",
        },
        "tags": {
            "romantic", "love", "love songs", "intimate",
            "sensual", "sexy", "tender", "passionate",
            "slow jam", "smooth", "seductive",
        },
    },
    "danceable": {
        "triggers": {
            "dance", "danceable", "dancing", "club", "party",
            "groovy", "groove", "rhythmic", "edm", "house",
            "techno", "disco", "funky",
        },
        "tags": {
            "dance", "danceable", "dancefloor", "club",
            "party", "groovy", "groove", "rhythmic",
            "edm", "house", "techno", "disco", "funky",
            "electronic dance", "uptempo",
        },
    },
}


def detect_mood(prompt_text: str | None) -> str | None:
    """Return the matching mood category, or None if no triggers fire.

    Uses substring match on a normalized prompt so multi-word triggers
    ("feel good", "high energy") work without exact-match fragility.
    """
    if not prompt_text:
        return None
    norm = prompt_text.lower().strip()
    if not norm:
        return None

    # Score each mood by how many distinct triggers appear in the
    # prompt. A multi-word trigger only counts once per match; this
    # naturally tilts toward the most specific mood.
    best: tuple[str, int] | None = None
    for mood, spec in MOODS.items():
        hits = sum(1 for trig in spec["triggers"] if trig in norm)
        if hits == 0:
            continue
        if best is None or hits > best[1]:
            best = (mood, hits)
    return best[0] if best else None


def mood_fit(mood: str | None, tags: list[str] | None) -> float:
    """Return the track's mood-fit score in ``[0, 1]``.

    Defined as the fraction of the track's tags that belong to the
    mood category's tag set. Returns 0 when either input is empty.
    """
    if not mood or not tags:
        return 0.0
    spec = MOODS.get(mood)
    if not spec:
        return 0.0
    target = spec["tags"]
    if not target:
        return 0.0
    matches = sum(1 for t in tags if t and t.lower() in target)
    if matches == 0:
        return 0.0
    # Fraction of the track's tags that are in-category. Capped at 1.0.
    return min(1.0, matches / max(len(tags), 1))
