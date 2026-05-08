from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone
from uuid import uuid4


def _norm_track_ids(track_ids: list[str]) -> list[str]:
    return [t.strip() for t in track_ids if isinstance(t, str) and t.strip()]


def signature_from_ordered(track_ids: list[str]) -> str:
    normalized = _norm_track_ids(track_ids)
    payload = "|".join(normalized)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def set_hash_from_sorted(track_ids: list[str]) -> str:
    normalized = sorted(set(_norm_track_ids(track_ids)))
    payload = "|".join(normalized)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def load_recent_history(client, user_id: str, history_window_runs: int = 50) -> list[dict]:
    try:
        resp = (
            client.table("discover_history")
            .select("id,run_id,created_at,track_ids,list_signature,artist_ids")
            .eq("user_id", user_id)
            .order("created_at", desc=True)
            .limit(max(1, min(history_window_runs, 500)))
            .execute()
        )
    except Exception:
        # Keep recommendations working if the artist-history migration has
        # not landed yet. Track-level novelty still works with the old shape.
        resp = (
            client.table("discover_history")
            .select("id,run_id,created_at,track_ids,list_signature")
            .eq("user_id", user_id)
            .order("created_at", desc=True)
            .limit(max(1, min(history_window_runs, 500)))
            .execute()
        )
    return resp.data or []


def build_excluded_track_ids(history_rows: list[dict], older_than_days: int | None = None) -> set[str]:
    threshold = None
    if older_than_days is not None:
        threshold = datetime.now(timezone.utc) - timedelta(days=older_than_days)

    excluded: set[str] = set()
    for row in history_rows:
        if threshold is not None:
            created_at = row.get("created_at")
            if created_at:
                try:
                    dt = datetime.fromisoformat(str(created_at).replace("Z", "+00:00"))
                    if dt < threshold:
                        continue
                except ValueError:
                    pass
        excluded.update(_norm_track_ids(row.get("track_ids") or []))
    return excluded


def build_excluded_artist_ids(history_rows: list[dict], older_than_days: int | None = None) -> set[int]:
    """Build set of artist IDs shown in recent discover runs."""
    threshold = None
    if older_than_days is not None:
        threshold = datetime.now(timezone.utc) - timedelta(days=older_than_days)

    excluded: set[int] = set()
    for row in history_rows:
        if threshold is not None:
            created_at = row.get("created_at")
            if created_at:
                try:
                    dt = datetime.fromisoformat(str(created_at).replace("Z", "+00:00"))
                    if dt < threshold:
                        continue
                except ValueError:
                    pass
        for aid in (row.get("artist_ids") or []):
            try:
                excluded.add(int(aid))
            except (TypeError, ValueError):
                pass
    return excluded


def overlap_ratio(candidate_ids: list[str], prior_ids: set[str]) -> float:
    normalized = _norm_track_ids(candidate_ids)
    if not normalized:
        return 0.0
    overlap = sum(1 for tid in normalized if tid in prior_ids)
    return overlap / len(normalized)


def artist_overlap_ratio(candidate_artist_ids: list[int], prior_artist_ids: set[int]) -> float:
    if not candidate_artist_ids:
        return 0.0
    overlap = sum(1 for aid in candidate_artist_ids if aid in prior_artist_ids)
    return overlap / len(candidate_artist_ids)


def has_signature_collision(client, user_id: str, list_signature: str) -> bool:
    resp = (
        client.table("discover_history")
        .select("id")
        .eq("user_id", user_id)
        .eq("list_signature", list_signature)
        .limit(1)
        .execute()
    )
    return bool(resp.data)


def persist_discover_run(
    client,
    user_id: str,
    track_ids: list[str],
    artist_ids: list[int],
    prompt: str | None,
    weights: dict[str, float] | None,
    lane_distribution: dict[str, int] | None = None,
    run_id: str | None = None,
) -> dict:
    ordered = _norm_track_ids(track_ids)
    payload = {
        "user_id": user_id,
        "run_id": run_id or str(uuid4()),
        "prompt": prompt,
        "weights": weights or {},
        "track_ids": ordered,
        "artist_ids": artist_ids,
        "track_set_hash": set_hash_from_sorted(ordered),
        "list_signature": signature_from_ordered(ordered),
        "lane_distribution": lane_distribution or {},
    }
    try:
        resp = client.table("discover_history").insert(payload).execute()
    except Exception:
        payload.pop("artist_ids", None)
        payload.pop("lane_distribution", None)
        resp = client.table("discover_history").insert(payload).execute()
    return (resp.data or [payload])[0]
