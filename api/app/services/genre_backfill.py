"""One-time backfill: fetch Last.fm tags as genres for all artists.

Most artists were enriched before genres were saved. This service
fetches Last.fm tags for any artist that has an empty genres array
and a non-null name.
"""

from __future__ import annotations

import time

import httpx

from app.config import settings
from app.services.supabase_client import admin_supabase


def run_genre_backfill() -> dict:
    """Fetch Last.fm tags for artists with empty genres. Returns summary."""

    # Get artists with empty genres
    all_artists: list[dict] = []
    offset = 0
    page_size = 500

    while True:
        resp = (
            admin_supabase.table("artists")
            .select("id,name,genres")
            .range(offset, offset + page_size - 1)
            .execute()
        )
        rows = resp.data or []
        for row in rows:
            genres = row.get("genres") or []
            if not genres and row.get("name"):
                all_artists.append(row)
        if len(rows) < page_size:
            break
        offset += page_size

    print(f"genre_backfill: {len(all_artists)} artists need genres")

    updated = 0
    errors = 0
    last_error = None

    with httpx.Client(timeout=10) as client:
        for i, artist in enumerate(all_artists):
            try:
                tags = _fetch_lastfm_tags(client, artist["name"])
                if tags:
                    admin_supabase.table("artists").update(
                        {"genres": tags[:10]}
                    ).eq("id", artist["id"]).execute()
                    updated += 1

                # Last.fm rate limit: ~5 req/s is safe
                if (i + 1) % 4 == 0:
                    time.sleep(0.3)

                if (i + 1) % 100 == 0:
                    print(f"genre_backfill: {i+1}/{len(all_artists)} processed, "
                          f"{updated} updated")

            except Exception as exc:
                errors += 1
                last_error = str(exc)[:200]
                if errors > 30:
                    print(f"genre_backfill: too many errors ({errors}), stopping")
                    break
                time.sleep(1)

    summary = {
        "total": len(all_artists),
        "updated": updated,
        "errors": errors,
    }
    if last_error:
        summary["last_error"] = last_error
    print(f"genre_backfill: done — {summary}")
    return summary


def _fetch_lastfm_tags(client: httpx.Client, name: str) -> list[str]:
    """Fetch top tags for an artist from Last.fm."""
    resp = client.get(
        "https://ws.audioscrobbler.com/2.0/",
        params={
            "method": "artist.getTopTags",
            "artist": name,
            "api_key": settings.lastfm_api_key,
            "format": "json",
        },
    )
    if resp.status_code != 200:
        return []

    data = resp.json()
    if "error" in data:
        return []

    tags = data.get("toptags", {}).get("tag") or []
    # Filter out generic/useless tags and take top 8
    skip = {"seen live", "favorites", "favorite", "spotify", "check"}
    return [
        t["name"].lower()
        for t in tags[:15]
        if t.get("name") and t["name"].lower() not in skip
    ][:8]
