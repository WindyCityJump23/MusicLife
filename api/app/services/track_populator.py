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


TRACKS_PER_ARTIST = 10  # How many tracks to fetch per artist
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
    consecutive_auth_errors = 0
    last_error: str | None = None
    consecutive_401s = 0
    processed = 0

    # Skip artists that already have tracks in the DB
    existing_artist_ids = _get_artists_with_tracks()
    before_skip = len(artists)
    artists = [a for a in artists if a["id"] not in existing_artist_ids]
    skipped = before_skip - len(artists)
    total = len(artists)
    print(f"track_populator: {skipped} already have tracks, {total} to process", flush=True)

    if not artists:
        return {"artists_total": before_skip, "artists_processed": 0, "tracks_added": 0, "skipped": skipped}
    if progress:
        progress(f"Populating track catalog (0/{total}, {skipped} skipped)")

    with httpx.Client(timeout=15) as client:
        # Validate token — retry on 429 (rate limit) with exponential backoff
        print(f"track_populator: validating Spotify token (len={len(access_token)})", flush=True)
        MAX_RETRY_WAIT = 60  # Never wait more than 60s per retry
        for attempt in range(5):
            test_resp = client.get(
                "https://api.spotify.com/v1/search",
                params={"q": "test", "type": "track", "limit": 1},
                headers=headers,
            )
            print(f"track_populator: token test HTTP {test_resp.status_code} (attempt {attempt+1})", flush=True)
            if test_resp.status_code == 429:
                retry_after = int(test_resp.headers.get("Retry-After", "5"))
                # If Spotify says wait more than 5 min, the rate limit is
                # too severe (dev mode) — abort instead of blocking forever
                if retry_after > 300:
                    msg = (f"Spotify rate limit too severe ({retry_after}s / ~{retry_after//3600}h). "
                           f"Try again in a few minutes. This is a Spotify dev-mode restriction.")
                    print(f"track_populator: {msg}", flush=True)
                    if progress:
                        progress(msg)
                    return {"artists_total": before_skip, "artists_processed": 0, "tracks_added": 0, "error": msg}
                wait = min(max(retry_after, 2 ** attempt), MAX_RETRY_WAIT)
                print(f"track_populator: rate limited, waiting {wait}s", flush=True)
                if progress:
                    progress(f"Spotify rate limit — waiting {wait}s before retrying...")
                time.sleep(wait)
                continue
            break

        if test_resp.status_code in (401, 403):
            msg = f"Spotify token expired or invalid (HTTP {test_resp.status_code}). Please sign out and back in."
            print(f"track_populator: {msg}", flush=True)
            if progress:
                progress(msg)
            return {"artists_total": before_skip, "artists_processed": 0, "tracks_added": 0, "error": msg}
        if test_resp.status_code != 200:
            msg = f"Spotify API error (HTTP {test_resp.status_code}): {test_resp.text[:200]}"
            print(f"track_populator: {msg}", flush=True)
            if progress:
                progress(msg)
            return {"artists_total": before_skip, "artists_processed": 0, "tracks_added": 0, "error": msg}

        print(f"track_populator: starting loop for {total} artists", flush=True)
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

                # Rate limit: Spotify allows ~30 req/sec but be very conservative
                # to avoid 429s, especially after setup steps 1-4 burned quota
                if (i + 1) % 3 == 0:
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

            # Update progress every 5 artists (not 10) for better UI feedback
            if progress and ((i + 1) % 5 == 0 or i == 0):
                err_suffix = f" ({errors} errors)" if errors > 0 else ""
                progress(f"Populating track catalog ({i + 1}/{total}, {total_added} tracks added{err_suffix})")

            if errors > ABORT_AFTER_ERRORS:
                print(
                    f"track_populator: too many errors ({errors}), aborting",
                    flush=True,
                )
                break

    summary = {
        "artists_total": before_skip,
        "artists_processed": processed,
        "tracks_added": total_added,
        "skipped": skipped,
        "errors": errors,
    }
    if last_error:
        summary["last_error"] = last_error

    if progress:
        progress(f"Populating track catalog ({processed}/{total})")

    print(f"track_populator: done — {summary}", flush=True)
    return summary


def _get_artists_with_tracks() -> set[int]:
    """Return set of artist IDs that already have at least one track."""
    ids: set[int] = set()
    offset = 0
    page_size = 1000

    while True:
        resp = (
            admin_supabase.table("tracks")
            .select("artist_id")
            .not_.is_("artist_id", "null")
            .range(offset, offset + page_size - 1)
            .execute()
        )
        rows = resp.data or []
        for row in rows:
            aid = row.get("artist_id")
            if aid is not None:
                ids.add(aid)
        if len(rows) < page_size:
            break
        offset += page_size

    return ids


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


def _retry_429(
    client: httpx.Client,
    method: str,
    url: str,
    headers: dict[str, str],
    params: dict | None = None,
) -> httpx.Response:
    """Make an HTTP request with automatic 429 retry (up to 2 retries, capped at 60s)."""
    for attempt in range(3):
        resp = client.request(method, url, params=params, headers=headers)
        if resp.status_code != 429:
            return resp
        retry_after = int(resp.headers.get("Retry-After", "5"))
        if retry_after > 300:
            return resp  # Let caller handle severe rate limits
        wait = min(max(retry_after, 5 * (attempt + 1)), 60)
        print(f"track_populator: 429 on {url.split('/')[-1]}, waiting {wait}s (attempt {attempt+1})", flush=True)
        time.sleep(wait)
    return resp  # Return last response even if still 429


def _search_and_upsert_tracks(
    client: httpx.Client,
    headers: dict[str, str],
    artist: dict,
    limit: int,
) -> tuple[int, str | None]:
    """Fetch tracks for an artist and upsert them.

    Strategy: Use /artists/{id}/top-tracks if we have a spotify_artist_id
    (direct lookup, cheaper on rate limits). Fall back to Search API.

    Returns (tracks_upserted, error_message_or_None).
    """
    artist_name = (artist.get("name") or "").strip()
    artist_db_id = artist["id"]
    spotify_artist_id = (artist.get("spotify_artist_id") or "").strip()

    if not artist_name:
        return 0, None

    items: list[dict] = []

    # Prefer top-tracks endpoint (direct, no text search, 1 API call)
    if spotify_artist_id:
        resp = _retry_429(
            client, "GET",
            f"https://api.spotify.com/v1/artists/{spotify_artist_id}/top-tracks",
            headers=headers,
            params={"market": "US"},
        )
        if resp.status_code == 429:
            retry_after = int(resp.headers.get("Retry-After", "5"))
            return 0, f"Spotify rate limit too severe ({retry_after}s)"
        if resp.status_code == 200:
            items = resp.json().get("tracks", [])[:limit]
        elif resp.status_code == 403:
            # Dev mode may block top-tracks; fall through to search
            pass
        elif resp.status_code in (401,):
            body = (resp.text or "")[:120]
            return 0, f"spotify top-tracks HTTP {resp.status_code} for '{artist_name}': {body}"

    # Fallback: Search API
    if not items:
        quoted = artist_name.replace('"', '\\"')
        query = f'artist:"{quoted}"'
        params = {"q": query, "type": "track", "market": "US", "limit": limit}
        resp = _retry_429(
            client, "GET",
            "https://api.spotify.com/v1/search",
            headers=headers,
            params=params,
        )
        if resp.status_code == 429:
            retry_after = int(resp.headers.get("Retry-After", "5"))
            return 0, f"Spotify rate limit too severe ({retry_after}s)"

    if resp.status_code == 401:
        return 0, f"spotify token expired or invalid for '{artist_name}' (HTTP 401)"

    if resp.status_code != 200:
        body = (resp.text or "")[:120]
        return 0, f"spotify HTTP {resp.status_code} for '{artist_name}': {body}"

    # Parse items — top-tracks returns {tracks: [...]}, search returns {tracks: {items: [...]}}
    if not items:
        data = resp.json()
        tracks_data = data.get("tracks")
        if isinstance(tracks_data, list):
            # /artists/{id}/top-tracks format
            items = tracks_data[:limit]
        elif isinstance(tracks_data, dict):
            # /search format
            items = tracks_data.get("items") or []
    if not items:
        return 0, None

    rows = []
    for track in items:
        spotify_track_id = track.get("id")
        if not spotify_track_id:
            continue

        track_name = track.get("name") or "Unknown"
        album = track.get("album") or {}
        album_name = album.get("name")
        embedding_source = _compose_embedding_source(
            artist_name, track_name, album_name
        )

        # Spotify returns release_date as "YYYY-MM-DD", "YYYY-MM", or "YYYY".
        # Normalise to a full date string so Postgres DATE cast works.
        release_date: str | None = None
        raw_date = album.get("release_date") or ""
        if raw_date:
            parts = raw_date.split("-")
            if len(parts) == 1:
                release_date = f"{parts[0]}-01-01"
            elif len(parts) == 2:
                release_date = f"{parts[0]}-{parts[1]}-01"
            else:
                release_date = raw_date  # already YYYY-MM-DD

        rows.append({
            "spotify_track_id": spotify_track_id,
            "artist_id": artist_db_id,
            "name": track_name,
            "album_name": album_name,
            "release_date": release_date,
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
