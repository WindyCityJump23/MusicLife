"""Populate tracks table for all artists using Spotify Search API.

The artists/{id}/top-tracks endpoint returns 403 for Spotify apps in
Development Mode (restricted since Spotify's Nov 2024 API changes).
The Search API still works, so we search for tracks by each artist.

This service:
  1. Finds all artists with a spotify_artist_id
  2. For each, searches Spotify for tracks by that artist
  3. Upserts the results into the tracks table (idempotent on
     spotify_track_id), with popularity + metadata
"""

from __future__ import annotations

import time
from typing import Callable

import httpx

from app.services.supabase_client import admin_supabase


TRACKS_PER_ARTIST = 5  # How many tracks to fetch per artist
ABORT_AFTER_ERRORS = 20
# Cap Retry-After sleep so a single 429 can't freeze the entire job.
# If Spotify asks us to wait longer, we skip and count it as an error.
MAX_RETRY_AFTER_SECS = 30


def run_track_population(
    access_token: str,
    progress: Callable[[str], None] | None = None,
) -> dict:
    """Populate tracks for all artists with a spotify_artist_id.

    The tracks table has a unique constraint on spotify_track_id, so the
    upsert is idempotent — re-runs on already-populated artists are safe
    and fast (no duplicate rows).

    Args:
        access_token: A valid Spotify access token (any user's will do —
                      Search API doesn't require special scopes).

    Returns:
        Summary dict with counts.
    """
    print("track_populator: starting", flush=True)
    headers = {"Authorization": f"Bearer {access_token}"}

    artists = _fetch_all_artists()
    total = len(artists)
    print(f"track_populator: {total} artists to process", flush=True)
    if not artists:
        return {"artists_total": 0, "artists_processed": 0, "tracks_added": 0}
    if progress:
        progress(f"Populating track catalog (0/{total})")

    total_added = 0
    errors = 0
    last_error: str | None = None
    consecutive_401s = 0
    processed = 0

    with httpx.Client(timeout=15) as client:
        for i, artist in enumerate(artists):
            try:
                added, err = _search_and_upsert_tracks(
                    client, headers, artist, TRACKS_PER_ARTIST
                )
                total_added += added
                processed = i + 1

                if err:
                    errors += 1
                    last_error = err
                    # Fast-abort on token expiry: 3 consecutive 401s means the
                    # token is dead and every remaining artist will fail too.
                    if "401" in (err or ""):
                        consecutive_401s += 1
                        if consecutive_401s >= 3:
                            print(
                                "track_populator: Spotify token expired (3 consecutive 401s), aborting",
                                flush=True,
                            )
                            break
                    else:
                        consecutive_401s = 0
                else:
                    consecutive_401s = 0

                # Rate limit: Spotify allows ~30 req/sec but be conservative
                if (i + 1) % 5 == 0:
                    time.sleep(0.5)

                # Progress logging every 50 artists
                if (i + 1) % 50 == 0:
                    print(
                        f"track_populator: {i+1}/{total} artists "
                        f"processed, {total_added} tracks added, "
                        f"{errors} errors",
                        flush=True,
                    )

            except Exception as exc:
                errors += 1
                last_error = str(exc)[:200]
                consecutive_401s = 0
                time.sleep(1)  # Back off on transient failures

            # Update progress every 10 artists regardless of success/error.
            if progress and (i + 1) % 10 == 0:
                progress(f"Populating track catalog ({i + 1}/{total})")

            if errors > ABORT_AFTER_ERRORS:
                print(
                    f"track_populator: too many errors ({errors}), aborting",
                    flush=True,
                )
                break

    summary = {
        "artists_total": len(artists),
        "artists_processed": processed,
        "tracks_added": total_added,
        "errors": errors,
    }
    if last_error:
        summary["last_error"] = last_error

    if progress:
        progress(f"Populating track catalog ({processed}/{total})")

    print(f"track_populator: done — {summary}", flush=True)
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


def _compose_embedding_source(
    artist_name: str | None,
    track_name: str | None,
    album_name: str | None,
) -> str | None:
    parts = [
        (artist_name or "").strip(),
        (track_name or "").strip(),
        (album_name or "").strip(),
    ]
    parts = [p for p in parts if p]
    if not parts:
        return None
    return " – ".join(parts)


def _search_and_upsert_tracks(
    client: httpx.Client,
    headers: dict[str, str],
    artist: dict,
    limit: int,
) -> tuple[int, str | None]:
    """Search Spotify for tracks by this artist and upsert them.

    Returns (tracks_upserted, error_message_or_None). A non-None error
    message indicates the Spotify call failed in a way the caller should
    surface (e.g. auth, server error). Empty result sets are not errors.
    """
    artist_name = (artist.get("name") or "").strip()
    artist_db_id = artist["id"]

    if not artist_name:
        return 0, None

    # Spotify field filters require quoting for multi-word values.
    # Without quotes, `artist:Taylor Swift` is parsed as `artist:Taylor`
    # plus a free term `Swift`, returning poor or empty results.
    quoted = artist_name.replace('"', '\\"')
    query = f'artist:"{quoted}"'

    params = {"q": query, "type": "track", "market": "US", "limit": limit}
    resp = client.get(
        "https://api.spotify.com/v1/search",
        params=params,
        headers=headers,
    )

    if resp.status_code == 429:
        retry_after = int(resp.headers.get("Retry-After", "5"))
        if retry_after > MAX_RETRY_AFTER_SECS:
            return 0, (
                f"spotify rate-limited for '{artist_name}': "
                f"Retry-After={retry_after}s exceeds cap; skipping"
            )
        time.sleep(retry_after)
        resp = client.get(
            "https://api.spotify.com/v1/search",
            params=params,
            headers=headers,
        )

    if resp.status_code == 401:
        return 0, f"spotify token expired or invalid for '{artist_name}' (HTTP 401)"

    if resp.status_code != 200:
        body = (resp.text or "")[:120]
        return 0, f"spotify search HTTP {resp.status_code} for '{artist_name}': {body}"

    data = resp.json()
    items = (data.get("tracks") or {}).get("items") or []
    if not items:
        return 0, None

    rows = []
    for track in items:
        spotify_track_id = track.get("id")
        if not spotify_track_id:
            continue

        track_name = track.get("name") or "Unknown"
        album_name = (track.get("album") or {}).get("name")
        embedding_source = _compose_embedding_source(
            artist_name, track_name, album_name
        )

        rows.append({
            "spotify_track_id": spotify_track_id,
            "artist_id": artist_db_id,
            "name": track_name,
            "album_name": album_name,
            "duration_ms": track.get("duration_ms"),
            "explicit": track.get("explicit") or False,
            "popularity": track.get("popularity"),
            "embedding_source": embedding_source,
        })

    if not rows:
        return 0, None

    admin_supabase.table("tracks").upsert(
        rows, on_conflict="spotify_track_id"
    ).execute()

    return len(rows), None
