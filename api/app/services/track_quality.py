"""Filters for utility audio that should not leak into normal Radio stations."""
from __future__ import annotations

import re
from typing import Any


_UTILITY_TITLE_PATTERNS = [
    re.compile(r"\binstrumental(?:\s+(?:version|mix|edit|remake|cover))?\b", re.I),
    re.compile(r"\btype\s+beat\b", re.I),
    re.compile(r"\b(?:free|rap|hip[- ]?hop|trap|drill|r&b|pop|lo[- ]?fi|chill)\s+beats?\b", re.I),
    re.compile(r"\bbeats?\s+(?:to\s+(?:study|relax|sleep)|for\s+(?:studying|sleep|focus))\b", re.I),
    re.compile(r"\bkaraoke\b", re.I),
    re.compile(r"\bbacking\s+track\b", re.I),
    re.compile(r"\b(?:meditation|sleep|study|focus|relaxation)\s+(?:music|sounds?|beats?)\b", re.I),
    re.compile(r"\b(?:slowed(?:\s*(?:and|&)\s*reverb)?|sped\s+up)\b", re.I),
    # Content-farm signatures observed in live stations. Kept in lockstep with
    # web/lib/track-quality.ts — update both together. "lyric" is deliberately
    # unanchored at the end so the common "lyricss" misspelling still matches.
    re.compile(r"\bno\s+(?:lyric|vocal)", re.I),
    re.compile(r"\b(?:study|sleep|chill|focus|workout|relaxation)\s+(?:pop|hits|mix|radio|playlist)\b", re.I),
    re.compile(r"\b(?:synthwave|lo[- ]?fi|chill)\s+radio\b", re.I),
]

# Artist names composed ENTIRELY of generic utility/descriptor words are
# playlist-farm accounts, not bands ("Clean Pop Music", "Synthwave Nation",
# "summer sax"). Real artists almost always carry a non-generic token
# ("Clean Bandit", "Nation of Language"), so requiring every token to be
# generic — and at least two tokens — keeps this safe. Mirror of the TS set.
_GENERIC_ARTIST_TOKENS = frozenset({
    "clean", "chill", "study", "sleep", "focus", "workout", "meditation",
    "relaxing", "relaxation", "calm", "summer", "winter", "sax", "saxophone",
    "piano", "guitar", "lofi", "lo", "fi", "synthwave", "ambient",
    "instrumental", "pop", "music", "beats", "radio", "nation", "vibes",
    "hits", "mix", "playlist", "station", "sounds", "songs", "cover",
    "covers", "tribute", "karaoke", "the", "and", "for", "of", "no", "lyrics",
})

_ARTIST_TOKEN_RE = re.compile(r"[^a-z0-9\s-]")


def is_utility_artist_name(name: object) -> bool:
    """True when an artist name is built entirely from generic utility words."""
    cleaned = _ARTIST_TOKEN_RE.sub("", str(name or "").lower())
    tokens = [tok for tok in re.split(r"[\s-]+", cleaned) if tok]
    if len(tokens) < 2:
        return False
    return all(tok in _GENERIC_ARTIST_TOKENS for tok in tokens)

_UTILITY_REQUEST_PATTERNS = [
    re.compile(r"\binstrumental\b", re.I),
    re.compile(r"\btype\s+beat\b", re.I),
    re.compile(r"\bbeats?\b", re.I),
    re.compile(r"\bkaraoke\b", re.I),
    re.compile(r"\bbacking\s+track\b", re.I),
    re.compile(r"\bmeditation\s+music\b", re.I),
]


def prompt_requests_utility_tracks(prompt_text: str | None) -> bool:
    """Return whether a prompt explicitly asks for instrumental or utility audio."""
    prompt = (prompt_text or "").strip()
    return bool(prompt and any(pattern.search(prompt) for pattern in _UTILITY_REQUEST_PATTERNS))


def has_utility_title(track: dict[str, Any]) -> bool:
    """Detect utility versions using metadata available from catalog and Spotify search."""
    text = " ".join(
        str(value or "")
        for value in (
            track.get("name"),
            track.get("album_name"),
            (track.get("album") or {}).get("name") if isinstance(track.get("album"), dict) else "",
        )
    )
    return any(pattern.search(text) for pattern in _UTILITY_TITLE_PATTERNS)


def should_exclude_utility_track(
    track: dict[str, Any],
    *,
    allow_instrumental_utility: bool = False,
) -> bool:
    """Exclude non-song audio from normal stations while preserving explicit opt-ins."""
    speechiness = track.get("speechiness")
    if speechiness is not None and float(speechiness) > 0.75:
        return True

    if allow_instrumental_utility:
        return False

    instrumentalness = track.get("instrumentalness")
    if instrumentalness is not None and float(instrumentalness) > 0.85:
        return True

    # Optional: rows from live Spotify search carry the artist name; catalog
    # rows usually don't, in which case this check is a no-op.
    if is_utility_artist_name(track.get("artist_name")):
        return True

    return has_utility_title(track)
