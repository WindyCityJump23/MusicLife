"""Backfill Last.fm listener/playcount stats for existing artists.

Spotify stopped returning popularity scores (mid-2026), so Last.fm listener
counts are the recognizability proxy (see migration 028). Enrichment captures
stats for NEW artists automatically; this job converges the back catalog.

Resumable by construction: only artists with lastfm_listeners IS NULL are
selected, and a definitive Last.fm "artist not found" writes 0 (instead of
leaving NULL) so the job never retries permanent misses forever. Transient
errors leave NULL for the next run.
"""

from __future__ import annotations

import time
from typing import Callable

import httpx

from app.config import settings
from app.services.supabase_client import admin_supabase

# Last.fm error code for "artist could not be found".
_LASTFM_NOT_FOUND = 6


def run_lastfm_stats_backfill(
    limit: int | None = None,
    progress: Callable[[str], None] | None = None,
) -> dict:
    """Fetch listeners/playcount for artists missing stats. Returns summary."""

    candidates: list[dict] = []
    offset = 0
    page_size = 500

    while True:
        resp = (
            admin_supabase.table("artists")
            .select("id,name")
            .is_("lastfm_listeners", "null")
            .not_.is_("name", "null")
            .range(offset, offset + page_size - 1)
            .execute()
        )
        rows = resp.data or []
        candidates.extend(row for row in rows if row.get("name"))
        if len(rows) < page_size:
            break
        offset += page_size
        if limit is not None and len(candidates) >= limit:
            break

    if limit is not None:
        candidates = candidates[: max(0, limit)]

    total = len(candidates)
    print(f"lastfm_stats_backfill: {total} artists need listener stats")
    if progress:
        progress(f"Fetching listener stats (0/{total})")

    updated = 0
    not_found = 0
    errors = 0
    last_error: str | None = None

    with httpx.Client(timeout=10) as client:
        for i, artist in enumerate(candidates):
            try:
                stats = _fetch_artist_stats(client, artist["name"])
                if stats == "not_found":
                    # Converge: mark looked-up-but-missing as 0 so the next
                    # run doesn't retry it forever.
                    admin_supabase.table("artists").update(
                        {"lastfm_listeners": 0}
                    ).eq("id", artist["id"]).execute()
                    not_found += 1
                elif stats is not None:
                    listeners, playcount = stats
                    update: dict = {"lastfm_listeners": listeners}
                    if playcount is not None:
                        update["lastfm_playcount"] = playcount
                    admin_supabase.table("artists").update(update).eq(
                        "id", artist["id"]
                    ).execute()
                    updated += 1

                # Last.fm rate limit: ~5 req/s is safe.
                if (i + 1) % 4 == 0:
                    time.sleep(0.3)

                if (i + 1) % 100 == 0:
                    print(
                        f"lastfm_stats_backfill: {i + 1}/{total} processed, "
                        f"{updated} updated, {not_found} not found"
                    )
                    if progress:
                        progress(f"Fetching listener stats ({i + 1}/{total})")

            except Exception as exc:
                errors += 1
                last_error = str(exc)[:200]
                if errors > 30:
                    print(f"lastfm_stats_backfill: too many errors ({errors}), stopping")
                    break
                time.sleep(1)

    summary: dict = {
        "total": total,
        "updated": updated,
        "not_found": not_found,
        "errors": errors,
    }
    if last_error:
        summary["last_error"] = last_error
    print(f"lastfm_stats_backfill: done — {summary}")
    return summary


def _fetch_artist_stats(
    client: httpx.Client, name: str
) -> tuple[int, int | None] | str | None:
    """Return (listeners, playcount), 'not_found' for permanent misses,
    or None for responses that should be retried on a later run."""
    resp = client.get(
        "https://ws.audioscrobbler.com/2.0/",
        params={
            "method": "artist.getInfo",
            "artist": name,
            "api_key": settings.lastfm_api_key,
            "format": "json",
            "autocorrect": 1,
        },
    )
    if resp.status_code != 200:
        return None

    data = resp.json()
    if data.get("error") == _LASTFM_NOT_FOUND:
        return "not_found"
    if "error" in data:
        return None

    stats = (data.get("artist") or {}).get("stats") or {}
    listeners = _int_or_none(stats.get("listeners"))
    if listeners is None:
        return None
    return listeners, _int_or_none(stats.get("playcount"))


def _int_or_none(value: object) -> int | None:
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return None
