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
    """Weight a saved/listened track using play count plus listen/save recency."""
    raw_play_count = row.get("play_count") or 0
    try:
        play_count = float(raw_play_count)
    except (TypeError, ValueError):
        play_count = 0.0

    base = play_count if play_count > 0 else 1.0
    recency_ts = row.get("last_played_at") or row.get("added_at")
    return base * recency_multiplier(recency_ts, now)


def favorite_preference_weight(created_at: object, now: datetime) -> float:
    """Weight an explicit favorite as a strong but gently decayed preference."""
    return 15.0 * recency_multiplier(created_at, now, floor=0.65, half_life_days=730.0)
