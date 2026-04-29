"""Populate tracks table for all artists using Spotify Search API.

The artists/{id}/top-tracks endpoint returns 403 for Spotify apps in
Development Mode (restricted since Spotify's Nov 2024 API changes).
The Search API still works, so we search for tracks by each artist.

This service:
  1. Finds all artists with a spotify_artist_id
  2. Identifies which ones have fewer than N tracks in the DB
  3. For each, searches Spotify for tracks by that artist
  4. Upserts the results into the tracks table with popularity + metadata
"""

from __future__ import annotations

import time
from collections import defaultdict

import httpx

from app.services.supabase_client import admin_supabase


TRACKS_PER_ARTIST = 5  # How many tracks to fetch per artist
MIN_EXISTING_TRACKS = 3  # Skip artists that already have this many tracks


def run_track_population(access_token: str) -> dict:
    """Populate tracks for all artists missing track data.

    Args:
        access_token: A valid Spotify access token (any user's will do —
                      Search API doesn't require special scopes).

    Returns:
        Summary dict with counts.
    """
    headers = {"Authorization": f"Bearer {access_token}"}

    # 1. Get all artists with Spotify IDs
    all_artists = _fetch_all_artists()
    if not all_artists:
        return {"artists_total": 0, "artists_processed": 0, "tracks_added": 0}

    # 2. Count existing tracks per artist
    existing_counts = _count_tracks_per_artist()

    # 3. Filter to artists needing tracks
    need_tracks = [
        a for a in all_artists
        if existing_counts.get(a["id"], 0) < MIN_EXISTING_TRACKS
        and a.get("spotify_artist_id")
    ]

    print(f"track_populator: {len(all_artists)} total artists, "
          f"{len(need_tracks)} need tracks")

    # 4. Search Spotify for each artist's tracks
    total_added = 0
    errors = 0
    last_error = None

    with httpx.Client(timeout=15) as client:
        for i, artist in enumerate(need_tracks):
            try:
                added = _search_and_upsert_tracks(
                    client, headers, artist, TRACKS_PER_ARTIST
                )
                total_added += added

                # Rate limit: Spotify allows ~30 req/sec but be conservative
                if (i + 1) % 5 == 0:
                    time.sleep(0.5)

                # Progress logging every 50 artists
                if (i + 1) % 50 == 0:
                    print(f"track_populator: {i+1}/{len(need_tracks)} artists "
                          f"processed, {total_added} tracks added")

            except Exception as exc:
                errors += 1
                last_error = str(exc)[:200]
                # Don't abort on individual failures
                if errors > 20:
                    print(f"track_populator: too many errors ({errors}), aborting")
                    break
                time.sleep(1)  # Back off on errors

    summary = {
        "artists_total": len(all_artists),
        "artists_processed": len(need_tracks),
        "tracks_added": total_added,
        "errors": errors,
    }
    if last_error:
        summary["last_error"] = last_error

    print(f"track_populator: done — {summary}")
    return summary


def _fetch_all_artists() -> list[dict]:
    """Fetch all artists that have a spotify_artist_id."""
    all_rows: list[dict] = []
    offset = 0
    page_size = 1000

    while True:
        resp = (
            admin_supabase.table("artists")
            .select("id,name,spotify_artist_id")
            .not_.is_("spotify_artist_id", "null")
            .range(offset, offset + page_size - 1)
            .execute()
        )
        rows = resp.data or []
        all_rows.extend(rows)
        if len(rows) < page_size:
            break
        offset += page_size

    return all_rows


def _count_tracks_per_artist() -> dict[int, int]:
    """Return {artist_id: track_count} for all tracks in the DB."""
    counts: dict[int, int] = defaultdict(int)
    offset = 0
    page_size = 1000

    while True:
        resp = (
            admin_supabase.table("tracks")
            .select("artist_id")
            .range(offset, offset + page_size - 1)
            .execute()
        )
        rows = resp.data or []
        for row in rows:
            aid = row.get("artist_id")
            if aid is not None:
                counts[int(aid)] += 1
        if len(rows) < page_size:
            break
        offset += page_size

    return dict(counts)


def _search_and_upsert_tracks(
    client: httpx.Client,
    headers: dict[str, str],
    artist: dict,
    limit: int,
) -> int:
    """Search Spotify for tracks by this artist and upsert them.

    Returns the number of tracks upserted.
    """
    artist_name = artist.get("name") or ""
    artist_db_id = artist["id"]

    if not artist_name.strip():
        return 0

    # Search for tracks by this artist
    query = f"artist:{artist_name}"
    resp = client.get(
        "https://api.spotify.com/v1/search",
        params={
            "q": query,
            "type": "track",
            "market": "US",
            "limit": limit,
        },
        headers=headers,
    )

    if resp.status_code == 429:
        # Rate limited — wait and retry once
        retry_after = int(resp.headers.get("Retry-After", "5"))
        time.sleep(retry_after)
        resp = client.get(
            "https://api.spotify.com/v1/search",
            params={"q": query, "type": "track", "market": "US", "limit": limit},
            headers=headers,
        )

    if resp.status_code != 200:
        return 0

    data = resp.json()
    items = (data.get("tracks") or {}).get("items") or []
    if not items:
        return 0

    rows = []
    for track in items:
        spotify_track_id = track.get("id")
        if not spotify_track_id:
            continue

        rows.append({
            "spotify_track_id": spotify_track_id,
            "artist_id": artist_db_id,
            "name": track.get("name") or "Unknown",
            "album_name": (track.get("album") or {}).get("name"),
            "duration_ms": track.get("duration_ms"),
            "explicit": track.get("explicit") or False,
            "popularity": track.get("popularity"),
        })

    if not rows:
        return 0

    admin_supabase.table("tracks").upsert(
        rows, on_conflict="spotify_track_id"
    ).execute()

    return len(rows)
