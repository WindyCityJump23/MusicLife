"""Populate tracks table for all artists using Spotify Search API.

The artists/{id}/top-tracks endpoint returns 403 for Spotify apps in
Development Mode (restricted since Spotify's Nov 2024 API changes).
The Search API still works, so we search for tracks by each artist.

This service:
  1. Finds all artists with a spotify_artist_id
  2. Identifies which ones have fewer than N tracks in the DB
  3. For each, searches Spotify for tracks by that artist
  4. Verifies the returned tracks are actually by that artist
  5. Upserts the results into the tracks table with popularity + metadata

Errors that should stop the run early (auth failure) are surfaced to the
caller instead of being silently swallowed.
"""

from __future__ import annotations

import time
from collections import defaultdict

import httpx

from app.services.supabase_client import admin_supabase


TRACKS_PER_ARTIST = 10  # How many tracks to fetch per artist
MIN_EXISTING_TRACKS = 5  # Skip artists that already have this many tracks


class SpotifyAuthExpired(Exception):
    """Raised when Spotify returns 401 — token died mid-run."""


def run_track_population(access_token: str) -> dict:
    """Populate tracks for all artists missing track data.

    Args:
        access_token: A valid Spotify access token (any user's will do —
                      Search API doesn't require special scopes).

    Returns:
        Summary dict with counts and (if applicable) an aborted flag.
    """
    headers = {"Authorization": f"Bearer {access_token}"}

    all_artists = _fetch_all_artists()
    if not all_artists:
        return {
            "artists_total": 0,
            "artists_processed": 0,
            "tracks_added": 0,
            "tracks_skipped_wrong_artist": 0,
            "http_failures": 0,
            "errors": 0,
            "aborted": False,
        }

    existing_counts = _count_tracks_per_artist()

    need_tracks = [
        a for a in all_artists
        if existing_counts.get(a["id"], 0) < MIN_EXISTING_TRACKS
        and a.get("spotify_artist_id")
    ]

    print(f"track_populator: {len(all_artists)} total artists, "
          f"{len(need_tracks)} need tracks")

    total_added = 0
    total_skipped_wrong_artist = 0
    http_failures = 0
    errors = 0
    last_error: str | None = None
    aborted = False
    abort_reason: str | None = None

    with httpx.Client(timeout=15) as client:
        for i, artist in enumerate(need_tracks):
            try:
                added, skipped = _search_and_upsert_tracks(
                    client, headers, artist, TRACKS_PER_ARTIST
                )
                total_added += added
                total_skipped_wrong_artist += skipped

                if (i + 1) % 5 == 0:
                    time.sleep(0.5)

                if (i + 1) % 50 == 0:
                    print(
                        f"track_populator: {i+1}/{len(need_tracks)} processed, "
                        f"{total_added} added, {total_skipped_wrong_artist} "
                        f"wrong-artist skipped, {http_failures} HTTP failures"
                    )

            except SpotifyAuthExpired as exc:
                # Stop immediately — every subsequent call would also 401.
                aborted = True
                abort_reason = str(exc)
                last_error = str(exc)[:200]
                print(
                    f"track_populator: aborting at {i+1}/{len(need_tracks)} — "
                    f"{abort_reason}"
                )
                break

            except _SpotifyHttpError as exc:
                # 4xx/5xx that isn't auth — count it but keep going. After
                # 20 consecutive-style failures, give up.
                http_failures += 1
                last_error = str(exc)[:200]
                if http_failures > 20:
                    aborted = True
                    abort_reason = (
                        f"too many HTTP failures ({http_failures}); last: {last_error}"
                    )
                    print(f"track_populator: aborting — {abort_reason}")
                    break
                time.sleep(1)

            except Exception as exc:
                errors += 1
                last_error = str(exc)[:200]
                if errors > 20:
                    aborted = True
                    abort_reason = f"too many errors ({errors}); last: {last_error}"
                    print(f"track_populator: aborting — {abort_reason}")
                    break
                time.sleep(1)

    summary = {
        "artists_total": len(all_artists),
        "artists_processed": len(need_tracks),
        "tracks_added": total_added,
        "tracks_skipped_wrong_artist": total_skipped_wrong_artist,
        "http_failures": http_failures,
        "errors": errors,
        "aborted": aborted,
    }
    if abort_reason:
        summary["abort_reason"] = abort_reason
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


class _SpotifyHttpError(Exception):
    """Non-auth HTTP failure from Spotify (rate-limit-after-retry, 5xx, …)."""


def _search_and_upsert_tracks(
    client: httpx.Client,
    headers: dict[str, str],
    artist: dict,
    limit: int,
) -> tuple[int, int]:
    """Search Spotify for tracks by this artist and upsert them.

    Returns `(added, skipped_wrong_artist)`. Raises `SpotifyAuthExpired`
    on 401 so the caller can stop immediately, or `_SpotifyHttpError`
    on other non-200 responses so the caller can count and keep going.
    """
    artist_name = artist.get("name") or ""
    artist_db_id = artist["id"]
    artist_spotify_id = artist.get("spotify_artist_id")

    if not artist_name.strip():
        return 0, 0

    query = f'artist:"{artist_name}"'
    params = {"q": query, "type": "track", "market": "US", "limit": limit}

    resp = client.get(
        "https://api.spotify.com/v1/search", params=params, headers=headers
    )

    if resp.status_code == 429:
        retry_after = int(resp.headers.get("Retry-After", "5"))
        time.sleep(min(retry_after, 30))
        resp = client.get(
            "https://api.spotify.com/v1/search", params=params, headers=headers
        )

    if resp.status_code == 401:
        raise SpotifyAuthExpired("Spotify access token expired mid-run")
    if resp.status_code != 200:
        raise _SpotifyHttpError(f"HTTP {resp.status_code}: {resp.text[:120]}")

    data = resp.json()
    items = (data.get("tracks") or {}).get("items") or []
    if not items:
        return 0, 0

    name_lower = artist_name.strip().lower()
    rows: list[dict] = []
    skipped = 0

    for track in items:
        spotify_track_id = track.get("id")
        if not spotify_track_id:
            continue

        # Verify the track is actually by this artist. Spotify's
        # `artist:NAME` filter returns near-matches and collabs where the
        # primary artist may be someone else — writing those rows with
        # *our* artist_id pollutes the catalog.
        track_artists = track.get("artists") or []
        if not _track_belongs_to_artist(
            track_artists, name_lower, artist_spotify_id
        ):
            skipped += 1
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
        return 0, skipped

    admin_supabase.table("tracks").upsert(
        rows, on_conflict="spotify_track_id"
    ).execute()

    return len(rows), skipped


def _track_belongs_to_artist(
    track_artists: list[dict],
    expected_name_lower: str,
    expected_spotify_id: str | None,
) -> bool:
    """True if the artist appears anywhere in the track's artist list.

    Match by Spotify ID when available (cheap and unambiguous), else by
    case-insensitive name. Permits collabs as long as the artist we
    searched for is actually credited.
    """
    for ta in track_artists:
        if expected_spotify_id and ta.get("id") == expected_spotify_id:
            return True
        ta_name = (ta.get("name") or "").strip().lower()
        if ta_name and ta_name == expected_name_lower:
            return True
    return False
