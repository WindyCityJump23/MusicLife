"""Interpret free-form music prompts before embedding/ranking.

Users often describe music with activities, references, moods, or complaints
instead of clean genre terms. This module keeps that language useful by
extracting the intended search phrase and expanding it into musical signals.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field


_TOKEN_RE = re.compile(r"[a-z0-9]+(?:[-'][a-z0-9]+)?")
_QUOTED_RE = re.compile(r"""["']([^"']{2,120})["']""")


@dataclass(frozen=True)
class QueryIntent:
    raw_prompt: str
    search_phrase: str
    expanded_prompt: str
    descriptors: list[str] = field(default_factory=list)
    categories: dict[str, list[str]] = field(default_factory=dict)
    extracted_from_sentence: bool = False

    def as_response(self) -> dict:
        return {
            "search_phrase": self.search_phrase,
            "expanded_prompt": self.expanded_prompt,
            "descriptors": self.descriptors,
            "categories": self.categories,
            "extracted_from_sentence": self.extracted_from_sentence,
        }


_EXTRACTION_PATTERNS = [
    re.compile(r"\btyped\s+(?:in|into)\s+(.+)$", re.I),
    re.compile(r"\bsearched\s+(?:for\s+)?(.+)$", re.I),
    re.compile(r"\blook(?:ing)?\s+for\s+(.+)$", re.I),
    re.compile(r"\bfind\s+(?:me\s+)?(?:some\s+)?(.+)$", re.I),
]

_TRAILING_FILLER_RE = re.compile(
    r"\s+(?:but|and|because|cause|cuz)\s+(?:it|they|that|this)\b.*$",
    re.I,
)

_GENERIC_MUSIC_WORDS = {
    "music",
    "song",
    "songs",
    "track",
    "tracks",
    "playlist",
    "recommendation",
    "recommendations",
    "vibe",
    "vibes",
}

_STOPWORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "by",
    "for",
    "from",
    "i",
    "in",
    "into",
    "it",
    "me",
    "my",
    "of",
    "on",
    "or",
    "please",
    "some",
    "that",
    "the",
    "this",
    "to",
    "when",
    "with",
}

_PHRASE_SIGNALS: dict[str, tuple[str, list[str]]] = {
    "darth vader": ("reference", ["dark", "ominous", "cinematic", "sci-fi", "villainous", "heavy", "dramatic"]),
    "star wars": ("reference", ["cinematic", "space", "sci-fi", "orchestral", "adventurous"]),
    "blade runner": ("reference", ["cyberpunk", "neon", "rainy", "synth-heavy", "nocturnal", "futuristic"]),
    "wes anderson": ("reference", ["quirky", "warm", "baroque pop", "nostalgic", "precise"]),
    "final boss": ("reference", ["dramatic", "intense", "dark", "epic", "high-stakes"]),
    "road trip": ("activity", ["driving", "open-road", "steady", "sunlit", "singalong"]),
    "late night": ("setting", ["nocturnal", "hazy", "intimate", "moody"]),
    "neon rain": ("setting", ["neon", "rainy", "nocturnal", "cinematic", "synth-heavy"]),
    "walking through": ("activity", ["steady", "immersive", "cinematic", "atmospheric"]),
}

_WORD_SIGNALS: dict[str, tuple[str, list[str]]] = {
    "trippy": ("mood", ["psychedelic", "surreal", "hazy", "spacey", "experimental"]),
    "psychedelic": ("mood", ["trippy", "surreal", "hazy", "expansive"]),
    "weird": ("mood", ["off-kilter", "experimental", "unusual", "playful"]),
    "evil": ("mood", ["dark", "ominous", "villainous", "dramatic"]),
    "dark": ("mood", ["moody", "ominous", "shadowy", "intense"]),
    "sad": ("mood", ["melancholy", "heartbroken", "tender", "minor-key"]),
    "heartbreak": ("mood", ["melancholy", "romantic", "wounded", "emotional"]),
    "happy": ("mood", ["bright", "upbeat", "joyful", "warm"]),
    "cozy": ("mood", ["warm", "soft", "intimate", "gentle"]),
    "sleepy": ("mood", ["soft", "slow", "dreamy", "low-energy"]),
    "angry": ("mood", ["aggressive", "heavy", "distorted", "cathartic"]),
    "chill": ("mood", ["relaxed", "smooth", "downtempo", "easygoing"]),
    "dreamy": ("mood", ["ethereal", "hazy", "soft-focus", "floating"]),
    "expensive": ("aesthetic", ["sleek", "polished", "luxurious", "minimal"]),
    "cyberpunk": ("aesthetic", ["neon", "futuristic", "synth-heavy", "nocturnal", "industrial"]),
    "cowboy": ("aesthetic", ["western", "dusty", "twangy", "wide-open"]),
    "western": ("aesthetic", ["cowboy", "dusty", "twangy", "cinematic"]),
    "vampire": ("aesthetic", ["gothic", "dark", "romantic", "nocturnal"]),
    "beach": ("setting", ["sunny", "coastal", "breezy", "warm", "laid-back"]),
    "fog": ("setting", ["misty", "ambient", "mysterious", "slow", "atmospheric"]),
    "rain": ("setting", ["rainy", "reflective", "nocturnal", "cinematic"]),
    "snow": ("setting", ["icy", "cold", "glossy", "wide-open", "winter"]),
    "winter": ("setting", ["cold", "icy", "spacious", "crisp"]),
    "mountain": ("setting", ["expansive", "outdoor", "cinematic", "fresh-air"]),
    "space": ("setting", ["cosmic", "sci-fi", "expansive", "synth-heavy"]),
    "ski": ("activity", ["gliding", "cold", "energetic", "mountain", "crisp", "forward-motion"]),
    "skiing": ("activity", ["gliding", "cold", "energetic", "mountain", "crisp", "forward-motion"]),
    "snowboard": ("activity", ["gliding", "cold", "energetic", "mountain", "crisp", "playful"]),
    "driving": ("activity", ["propulsive", "steady", "open-road", "focused"]),
    "coding": ("activity", ["focused", "steady", "minimal", "non-distracting"]),
    "study": ("activity", ["focused", "calm", "instrumental", "steady"]),
    "studying": ("activity", ["focused", "calm", "instrumental", "steady"]),
    "gym": ("activity", ["high-energy", "driving", "confident", "percussive"]),
    "workout": ("activity", ["high-energy", "driving", "confident", "percussive"]),
    "running": ("activity", ["propulsive", "steady", "energetic", "rhythmic"]),
    "party": ("activity", ["danceable", "upbeat", "social", "high-energy"]),
    "cooking": ("activity", ["warm", "groovy", "easygoing", "social"]),
    "boss": ("reference", ["dramatic", "intense", "epic", "high-stakes"]),
    "villain": ("reference", ["dark", "ominous", "cinematic", "confident"]),
    "alien": ("reference", ["sci-fi", "strange", "spacey", "experimental"]),
    "robot": ("reference", ["mechanical", "electronic", "futuristic", "precise"]),
    "ghost": ("reference", ["haunting", "ambient", "ethereal", "mysterious"]),
    "edm": ("mood", ["electronic", "dance", "high-energy", "bass-heavy", "festival", "synth-heavy"]),
    "lofi": ("mood", ["relaxed", "mellow", "downtempo", "warm", "nostalgic"]),
    "lo-fi": ("mood", ["relaxed", "mellow", "downtempo", "warm", "nostalgic"]),
}


def interpret_music_prompt(prompt: str | None) -> QueryIntent | None:
    """Return a cleaned and musically-expanded intent for a raw user prompt."""
    raw = (prompt or "").strip()
    if not raw:
        return None

    search_phrase, extracted = _extract_search_phrase(raw)
    tokens = _tokens(search_phrase)
    categories: dict[str, list[str]] = {}
    descriptors: list[str] = []

    lowered = search_phrase.lower()
    for phrase, (category, signals) in _PHRASE_SIGNALS.items():
        if phrase in lowered:
            _add_signals(categories, descriptors, category, signals)

    for token in tokens:
        signal = _WORD_SIGNALS.get(token)
        if signal:
            category, signals = signal
            _add_signals(categories, descriptors, category, signals)

    literal_terms = [
        token
        for token in tokens
        if token not in _STOPWORDS
        and token not in _GENERIC_MUSIC_WORDS
        and token not in _WORD_SIGNALS
    ][:8]

    expanded_prompt = _build_expanded_prompt(search_phrase, descriptors, literal_terms)
    return QueryIntent(
        raw_prompt=raw,
        search_phrase=search_phrase,
        expanded_prompt=expanded_prompt,
        descriptors=descriptors,
        categories=categories,
        extracted_from_sentence=extracted,
    )


def _extract_search_phrase(raw: str) -> tuple[str, bool]:
    stripped = _strip_noise(raw)

    quoted = _QUOTED_RE.search(stripped)
    if quoted:
        return _strip_noise(quoted.group(1)), True

    for pattern in _EXTRACTION_PATTERNS:
        match = pattern.search(stripped)
        if match:
            candidate = _strip_noise(match.group(1))
            if candidate:
                return candidate, candidate.lower() != stripped.lower()

    return stripped, False


def _strip_noise(value: str) -> str:
    cleaned = value.strip()
    cleaned = _TRAILING_FILLER_RE.sub("", cleaned)
    cleaned = re.sub(r"^[\s\"'`]+|[\s\"'`.!,?;:]+$", "", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned


def _tokens(value: str) -> list[str]:
    return [m.group(0).lower().replace("'", "") for m in _TOKEN_RE.finditer(value)]


def _add_signals(
    categories: dict[str, list[str]],
    descriptors: list[str],
    category: str,
    signals: list[str],
) -> None:
    bucket = categories.setdefault(category, [])
    for signal in signals:
        if signal not in bucket:
            bucket.append(signal)
        if signal not in descriptors:
            descriptors.append(signal)


def _build_expanded_prompt(
    search_phrase: str,
    descriptors: list[str],
    literal_terms: list[str],
) -> str:
    parts = [search_phrase]
    if descriptors:
        parts.append("musical vibe: " + ", ".join(descriptors[:24]))
    if literal_terms:
        parts.append("literal references: " + ", ".join(literal_terms))
    parts.append("recommend songs by mood, activity, setting, sound texture, and energy")
    return ". ".join(parts)
