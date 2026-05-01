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
        # Validate token on first request before committing to full loop
        print(f"track_populator: validating Spotify token (len={len(access_token)})", flush=True)
        test_resp = client.get(
            "https://api.spotify.com/v1/search",
            params={"q": "test", "type": "track", "limit": 1},
            headers=headers,
        )
        print(f"track_populator: token test HTTP {test_resp.status_code}", flush=True)
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
                if i < 3:
                    print(f"track_populator: artist {i}: {artist.get('name','?')} -> added={added} err={err}", flush=True)
                if err:
                    errors += 1
                    last_error = err
                    # Detect auth failures and abort early
                    if "401" in err or "403" in err:
                        consecutive_auth_errors += 1
                        if consecutive_auth_errors >= 3:
                            print("track_populator: Spotify token expired mid-run", flush=True)
                            last_error = "Spotify token expired. Sign out & back in, then retry."
                            break
                    else:
                        consecutive_auth_errors = 0
                else:
                    consecutive_auth_errors = 0

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
                time.sleep(1)

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
        "artists_processed": i + 1 if artists else 0,
        "tracks_added": total_added,
        "skipped": skipped,
        "errors": errors,
    }
    if last_error:
        summary["last_error"] = last_error

    if progress:
        progress(f"Populating track catalog ({summary['artists_processed']}/{total})")

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
        time.sleep(retry_after)
        resp = client.get(
            "https://api.spotify.com/v1/search",
            params=params,
            headers=headers,
        )

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
