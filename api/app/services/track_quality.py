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
]

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

    return has_utility_title(track)
