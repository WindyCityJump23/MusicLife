"""Backfill Last.fm per-track listener/playcount stats.

Migration 028 gave the ranker an artist-level recognizability proxy, but
every track inside an artist's catalog still shared one value — so the song
shortlist had nothing to separate a signature track from a filler album cut
and fell back to randomness. Last.fm's track.getInfo supplies per-track
listeners; this job converges the catalog (see migration 030).

Resumable by construction: only tracks with lastfm_listeners IS NULL are
selected, and a definitive Last.fm "track not found" writes 0 (instead of
leaving NULL) so the job never retries permanent misses forever. Transient
errors leave NULL for the next run.
"""

from __future__ import annotations

import time
from typing import Callable

import httpx

from app.config import settings
from app.services.supabase_client import admin_supabase, retry_on_disconnect

# Last.fm error code for "track could not be found".
_LASTFM_NOT_FOUND = 6


def run_track_stats_backfill(
    limit: int | None = 2000,
    progress: Callable[[str], None] | None = None,
) -> dict:
    """Fetch per-track listeners for tracks missing them. Returns summary."""

    candidates: list[dict] = []
    offset = 0
    page_size = 500

    while True:
        resp = retry_on_disconnect(
            lambda o=offset: (
                admin_supabase.table("tracks")
                .select("id,name,artist_id,artists(name)")
                .is_("lastfm_listeners", "null")
                .not_.is_("spotify_track_id", "null")
                .range(o, o + page_size - 1)
                .execute()
            ),
            attempts=3,
        )
        rows = resp.data or []
        candidates.extend(rows)
        if len(rows) < page_size:
            break
        offset += page_size
        if limit is not None and len(candidates) >= limit:
            break

    if limit is not None:
        candidates = candidates[: max(0, limit)]

    total = len(candidates)
    print(f"track_stats_backfill: {total} tracks need listener stats")
    if progress:
        progress(f"Fetching song popularity (0/{total})")

    updated = 0
    not_found = 0
    errors = 0
    last_error: str | None = None

    with httpx.Client(timeout=10) as client:
        for i, track in enumerate(candidates):
            artist_name = _artist_name(track)
            track_name = track.get("name")
            if not artist_name or not track_name:
                _mark_visited(track["id"], 0)
                not_found += 1
                continue

            try:
                stats = _fetch_track_stats(client, artist_name, track_name)
                if stats == "not_found":
                    # Converge: mark looked-up-but-missing as 0 so the next
                    # run doesn't retry it forever.
                    _mark_visited(track["id"], 0)
                    not_found += 1
                elif stats is not None:
                    listeners, playcount = stats
                    update: dict = {"lastfm_listeners": listeners}
                    if playcount is not None:
                        update["lastfm_playcount"] = playcount
                    retry_on_disconnect(
                        lambda t=track, u=update: (
                            admin_supabase.table("tracks")
                            .update(u)
                            .eq("id", t["id"])
                            .execute()
                        ),
                        attempts=3,
                    )
                    updated += 1

                # Last.fm rate limit: ~5 req/s is safe.
                if (i + 1) % 4 == 0:
                    time.sleep(0.3)

                if (i + 1) % 200 == 0:
                    print(
                        f"track_stats_backfill: {i + 1}/{total} processed, "
                        f"{updated} updated, {not_found} not found"
                    )
                    if progress:
                        progress(f"Fetching song popularity ({i + 1}/{total})")

            except Exception as exc:
                errors += 1
                last_error = str(exc)[:200]
                if errors > 30:
                    print(f"track_stats_backfill: too many errors ({errors}), stopping")
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
    print(f"track_stats_backfill: done — {summary}")
    return summary


def _artist_name(track: dict) -> str | None:
    """Pull the joined artist name out of a PostgREST embedded relation."""
    artist_obj = track.get("artists")
    if isinstance(artist_obj, list):
        artist_obj = artist_obj[0] if artist_obj else None
    if isinstance(artist_obj, dict):
        name = artist_obj.get("name")
        return str(name) if name else None
    return None


def _mark_visited(track_id: int, listeners: int) -> None:
    try:
        retry_on_disconnect(
            lambda: (
                admin_supabase.table("tracks")
                .update({"lastfm_listeners": listeners})
                .eq("id", track_id)
                .execute()
            ),
            attempts=3,
        )
    except Exception as exc:
        print(f"track_stats_backfill: could not mark track {track_id}: {exc}")


def _fetch_track_stats(
    client: httpx.Client, artist: str, track: str
) -> tuple[int, int | None] | str | None:
    """Return (listeners, playcount), 'not_found' for permanent misses,
    or None for responses that should be retried on a later run."""
    resp = client.get(
        "https://ws.audioscrobbler.com/2.0/",
        params={
            "method": "track.getInfo",
            "artist": artist,
            "track": track,
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

    info = data.get("track") or {}
    listeners = _int_or_none(info.get("listeners"))
    if listeners is None:
        return None
    return listeners, _int_or_none(info.get("playcount"))


def _int_or_none(value: object) -> int | None:
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return None
