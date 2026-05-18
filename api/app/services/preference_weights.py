"""Shared weighting helpers for user preference signals."""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Mapping


def parse_timestamp(value: object) -> datetime | None:
    """Parse Spotify/Supabase ISO timestamps into timezone-aware UTC datetimes."""
    if value is None:
        return None
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def recency_multiplier(
    timestamp: object,
    now: datetime,
    *,
    floor: float = 0.35,
    half_life_days: float = 365.0,
) -> float:
    """Return a gentle exponential recency multiplier in ``[floor, 1]``."""
    parsed = parse_timestamp(timestamp)
    if parsed is None:
        return 1.0

    current = now if now.tzinfo is not None else now.replace(tzinfo=timezone.utc)
    days_since = max((current.astimezone(timezone.utc) - parsed).total_seconds() / 86400.0, 0.0)
    floor = max(0.0, min(float(floor), 1.0))
    half_life_days = max(float(half_life_days), 1.0)
    return floor + (1.0 - floor) * math.pow(0.5, days_since / half_life_days)


def track_preference_weight(row: Mapping[str, object], now: datetime) -> float:
    """Weight an intentionally saved track for taste modeling.

    Spotify recently-played rows are useful for repeat avoidance, but they are
    not manual taste input. MusicLife Radio playback can show up in Spotify's
    recent history, so positive preference weight must come from saved-library
    intent instead of play_count/last_played_at.
    """
    saved_at = row.get("added_at")
    if not saved_at:
        return 0.0
    return recency_multiplier(saved_at, now)


def favorite_preference_weight(created_at: object, now: datetime) -> float:
    """Weight an explicit favorite as a strong but gently decayed preference."""
    return 15.0 * recency_multiplier(created_at, now, floor=0.65, half_life_days=730.0)
