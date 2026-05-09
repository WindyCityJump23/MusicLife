from __future__ import annotations

import hashlib
import json
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
    columns = "id,run_id,created_at,track_ids,artist_ids,lanes,prompt,prompt_mode,list_signature"
    try:
        resp = (
            client.table("discover_history")
            .select(columns)
            .eq("user_id", user_id)
            .order("created_at", desc=True)
            .limit(max(1, min(history_window_runs, 500)))
            .execute()
        )
    except Exception:
        # Migration 019 may not be applied yet in older environments. Keep
        # track-level novelty working while the deployment catches up.
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
        for aid in row.get("artist_ids") or []:
            try:
                excluded.add(int(aid))
            except (TypeError, ValueError):
                continue
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
    prompt: str | None,
    weights: dict[str, float] | None,
    run_id: str | None = None,
    results: list[dict] | None = None,
) -> dict:
    ordered = _norm_track_ids(track_ids)
    result_rows = results or []
    artist_ids: list[int] = []
    lanes: list[str] = []
    lane_counts: dict[str, int] = {}
    for row in result_rows:
        try:
            if row.get("artist_id") is not None:
                artist_ids.append(int(row["artist_id"]))
        except (TypeError, ValueError):
            pass
        lane = row.get("lane")
        if isinstance(lane, str) and lane:
            lanes.append(lane)
            lane_counts[lane] = lane_counts.get(lane, 0) + 1

    payload = {
        "user_id": user_id,
        "run_id": run_id or str(uuid4()),
        "prompt": prompt,
        "weights": weights or {},
        "track_ids": ordered,
        "track_set_hash": set_hash_from_sorted(ordered),
        "list_signature": signature_from_ordered(ordered),
    }
    if result_rows:
        payload.update(
            {
                "artist_ids": artist_ids,
                "lanes": lanes,
                "prompt_mode": "prompted" if prompt else "radio",
                "result_meta": {
                    "lane_counts": lane_counts,
                    "result_count": len(result_rows),
                },
            }
        )

    try:
        resp = client.table("discover_history").insert(payload).execute()
    except Exception:
        # Backward-compatible fallback when migration 019 is not present.
        payload.pop("artist_ids", None)
        payload.pop("lanes", None)
        payload.pop("prompt_mode", None)
        payload.pop("result_meta", None)
        resp = client.table("discover_history").insert(payload).execute()
    return (resp.data or [payload])[0]
