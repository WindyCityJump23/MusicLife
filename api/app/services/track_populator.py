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

import re
import time
from typing import Callable

import httpx

from app.services.supabase_client import admin_supabase, retry_on_disconnect


TRACKS_PER_ARTIST = 50  # Fetch deep into each artist's catalog
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

    # Skip artists that already have a deep catalog (>= 20 tracks).
    # Artists with fewer tracks were likely populated with the old
    # 10-track limit and need deepening.
    existing_track_counts = _get_artist_track_counts()
    before_skip = len(artists)
    artists = [a for a in artists if existing_track_counts.get(a["id"], 0) < 20]
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
        test_resp: httpx.Response | None = None
        for attempt in range(5):
            try:
                test_resp = client.get(
                    "https://api.spotify.com/v1/search",
                    params={"q": "test", "type": "track", "limit": 1},
                    headers=headers,
                )
            except httpx.TransportError as exc:
                wait = min(2 ** attempt, MAX_RETRY_WAIT)
                print(
                    f"track_populator: token test transport error "
                    f"({type(exc).__name__}: {exc}), waiting {wait}s",
                    flush=True,
                )
                if progress:
                    progress(f"Spotify connection dropped — retrying in {wait}s...")
                time.sleep(wait)
                continue
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

        if test_resp is None:
            msg = "Spotify connection dropped during token validation. Please retry."
            print(f"track_populator: {msg}", flush=True)
            if progress:
                progress(msg)
            return {"artists_total": before_skip, "artists_processed": 0, "tracks_added": 0, "error": msg}

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

                # Rate limit: each artist now makes multiple API calls
                # (albums + album tracks + search), so pause between artists
                time.sleep(1.0)

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


def _get_artist_track_counts() -> dict[int, int]:
    """Return a map of artist_id → track count."""
    counts: dict[int, int] = {}
    offset = 0
    page_size = 1000

    while True:
        resp = retry_on_disconnect(
            lambda: (
                admin_supabase.table("tracks")
                .select("artist_id")
                .not_.is_("artist_id", "null")
                .range(offset, offset + page_size - 1)
                .execute()
            ),
            attempts=3,
        )
        rows = resp.data or []
        for row in rows:
            aid = row.get("artist_id")
            if aid is not None:
                counts[aid] = counts.get(aid, 0) + 1
        if len(rows) < page_size:
            break
        offset += page_size

    return counts


def _fetch_all_artists() -> list[dict]:
    """Fetch all artists that have a spotify_artist_id."""
    all_rows: list[dict] = []
    offset = 0
    page_size = 1000

    while True:
        resp = retry_on_disconnect(
            lambda: (
                admin_supabase.table("artists")
                .select("id,name,spotify_artist_id")
                .not_.is_("spotify_artist_id", "null")
                .range(offset, offset + page_size - 1)
                .execute()
            ),
            attempts=3,
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


def _fetch_artist_albums(
    client: httpx.Client,
    headers: dict[str, str],
    spotify_artist_id: str,
) -> list[dict] | None:
    """Fetch an artist's albums (albums + singles). Returns None on error."""
    resp = _retry_429(
        client, "GET",
        f"https://api.spotify.com/v1/artists/{spotify_artist_id}/albums",
        headers=headers,
        params={"include_groups": "album,single", "market": "US", "limit": 50},
    )
    if resp.status_code == 403:
        return None
    if resp.status_code != 200:
        return None
    return resp.json().get("items") or []


def _fetch_album_tracks(
    client: httpx.Client,
    headers: dict[str, str],
    album_id: str,
    album_meta: dict,
) -> list[dict] | None:
    """Fetch all tracks from an album, enriching each with album metadata."""
    resp = _retry_429(
        client, "GET",
        f"https://api.spotify.com/v1/albums/{album_id}/tracks",
        headers=headers,
        params={"market": "US", "limit": 50},
    )
    if resp.status_code != 200:
        return None
    raw_tracks = resp.json().get("items") or []
    enriched = []
    for t in raw_tracks:
        t["album"] = {
            "name": album_meta.get("name"),
            "release_date": album_meta.get("release_date"),
            "release_date_precision": album_meta.get("release_date_precision"),
        }
        enriched.append(t)
    return enriched


def _hydrate_track_popularity(
    client: httpx.Client,
    headers: dict[str, str],
    items: list[dict],
) -> None:
    """Fill in ``popularity`` for album-sourced tracks, in place.

    ``/albums/{id}/tracks`` returns *simplified* track objects, which have no
    ``popularity`` field at all — so every track ingested through the album
    path landed with popularity NULL regardless of what Spotify's API does or
    doesn't still return. That left the ranker with no way to tell a signature
    song from an album cut. ``/tracks?ids=`` returns full track objects; one
    call per 50 tracks recovers the field when it is available.

    Best-effort: any failure leaves popularity as-is, and the Last.fm
    track-stats backfill (migration 030) remains the durable fallback.
    """
    missing = [t for t in items if t.get("id") and t.get("popularity") is None]
    if not missing:
        return

    for chunk_start in range(0, len(missing), 50):
        chunk = missing[chunk_start : chunk_start + 50]
        try:
            resp = _retry_429(
                client, "GET",
                "https://api.spotify.com/v1/tracks",
                headers=headers,
                params={"ids": ",".join(t["id"] for t in chunk), "market": "US"},
            )
        except httpx.TransportError as exc:
            print(f"track_populator: popularity hydrate failed (non-fatal): {exc}", flush=True)
            return
        if resp.status_code != 200:
            return
        by_id = {
            full["id"]: full
            for full in (resp.json().get("tracks") or [])
            if isinstance(full, dict) and full.get("id")
        }
        for track in chunk:
            full = by_id.get(track["id"])
            if full and full.get("popularity") is not None:
                track["popularity"] = full["popularity"]


def _retry_429(
    client: httpx.Client,
    method: str,
    url: str,
    headers: dict[str, str],
    params: dict | None = None,
) -> httpx.Response:
    """Make an HTTP request with retry for 429 and transient disconnects."""
    last_transport_error: httpx.TransportError | None = None
    resp: httpx.Response | None = None
    for attempt in range(3):
        try:
            resp = client.request(method, url, params=params, headers=headers)
        except httpx.TransportError as exc:
            last_transport_error = exc
            wait = min(2 * (attempt + 1), 8)
            print(
                f"track_populator: transport error on {url.split('/')[-1]} "
                f"({type(exc).__name__}: {exc}), waiting {wait}s "
                f"(attempt {attempt + 1})",
                flush=True,
            )
            time.sleep(wait)
            continue
        if resp.status_code != 429:
            return resp
        retry_after = int(resp.headers.get("Retry-After", "5"))
        if retry_after > 300:
            return resp  # Let caller handle severe rate limits
        wait = min(max(retry_after, 5 * (attempt + 1)), 60)
        print(f"track_populator: 429 on {url.split('/')[-1]}, waiting {wait}s (attempt {attempt+1})", flush=True)
        time.sleep(wait)
    if resp is not None:
        return resp  # Return last response even if still 429
    raise last_transport_error or httpx.TransportError("Spotify request failed")


def _normalize_artist_name(name: object) -> str:
    """Casefold and strip punctuation so name comparison is not brittle."""
    return re.sub(r"[^a-z0-9]+", "", str(name or "").lower())


def track_credits_artist(
    track: dict,
    spotify_artist_id: str,
    artist_name: str,
) -> bool:
    """Is this track actually credited to the artist we are populating?

    Every Spotify track object — full (search) and simplified (album tracks)
    alike — carries an ``artists`` array. Nothing used to read it: whatever a
    query returned was written with ``artist_id`` set to the artist we happened
    to be looking up, so an artist's row accumulated other people's music.

    Prefers the Spotify artist ID, which is exact. Falls back to a normalized
    name match only when the row has no ID to compare against, since that is
    the best available signal for artists that were created from editorial
    text rather than resolved against Spotify.
    """
    credited = track.get("artists")
    if not isinstance(credited, list) or not credited:
        # No credits to check. Without evidence, do not claim the track.
        return False

    if spotify_artist_id:
        return any(
            isinstance(entry, dict) and entry.get("id") == spotify_artist_id
            for entry in credited
        )

    target = _normalize_artist_name(artist_name)
    if not target:
        return False
    return any(
        isinstance(entry, dict) and _normalize_artist_name(entry.get("name")) == target
        for entry in credited
    )


def _search_and_upsert_tracks(
    client: httpx.Client,
    headers: dict[str, str],
    artist: dict,
    limit: int,
) -> tuple[int, str | None]:
    """Fetch tracks for an artist and upsert them.

    Strategy: Start with /artists/{id}/albums to get full discography,
    then fetch each album's tracks. This reaches deep cuts that never
    appear in top-tracks or search results. Falls back to Search API
    pagination when the albums endpoint is unavailable.

    Returns (tracks_upserted, error_message_or_None).
    """
    artist_name = (artist.get("name") or "").strip()
    artist_db_id = artist["id"]
    spotify_artist_id = (artist.get("spotify_artist_id") or "").strip()

    if not artist_name:
        return 0, None

    items: list[dict] = []
    seen_ids: set[str] = set()
    rejected = 0

    def _accept(t: dict) -> bool:
        """Take a track only if this artist is actually credited on it."""
        nonlocal rejected
        tid = t.get("id")
        if not tid or tid in seen_ids:
            return False
        if not track_credits_artist(t, spotify_artist_id, artist_name):
            rejected += 1
            return False
        seen_ids.add(tid)
        items.append(t)
        return True

    # Strategy 1: Albums → album tracks (reaches deep cuts)
    #
    # An album is pulled in when this artist is credited on it, but the album's
    # *other* tracks can belong to anyone — compilations, various-artists
    # records, and guest features all land here. Every track used to be kept,
    # so one guest verse filed an entire album under this artist.
    if spotify_artist_id:
        album_items = _fetch_artist_albums(client, headers, spotify_artist_id)
        if album_items is not None:
            for album in album_items[:20]:
                album_id = album.get("id")
                if not album_id:
                    continue
                album_tracks = _fetch_album_tracks(client, headers, album_id, album)
                if album_tracks is None:
                    continue
                for t in album_tracks:
                    _accept(t)
                    if len(items) >= limit:
                        break
                if len(items) >= limit:
                    break

    # Strategy 2: Search API to top up beyond what the albums endpoint gave.
    #
    # `artist:"Name"` is a fuzzy *text* filter, not an ID lookup, so it happily
    # returns other artists with similar names. Because the loop below used to
    # keep whatever came back, this was the main source of misattribution: a
    # search for a small artist would pad their row up to `limit` with music by
    # whoever else matched the string. Every candidate now has to be credited
    # to this artist, which means the top-up simply yields fewer tracks for
    # artists with small catalogs — the correct outcome.
    #
    # Spotify reduced the search limit from 50 to 10 in February 2026.
    SEARCH_PAGE = 10
    if len(items) < limit:
        quoted = artist_name.replace('"', '\\"')
        query = f'artist:"{quoted}"'
        for offset in range(0, limit, SEARCH_PAGE):
            batch = min(SEARCH_PAGE, limit - len(items))
            params = {"q": query, "type": "track", "market": "US", "limit": batch, "offset": offset}
            resp = _retry_429(
                client, "GET",
                "https://api.spotify.com/v1/search",
                headers=headers,
                params=params,
            )
            if resp.status_code == 429:
                retry_after = int(resp.headers.get("Retry-After", "5"))
                if not items:
                    return 0, f"Spotify rate limit too severe ({retry_after}s)"
                break
            if resp.status_code == 401:
                if not items:
                    return 0, f"spotify token expired or invalid for '{artist_name}' (HTTP 401)"
                break
            if resp.status_code != 200:
                if not items:
                    body = (resp.text or "")[:120]
                    return 0, f"spotify HTTP {resp.status_code} for '{artist_name}': {body}"
                break
            search_items = (resp.json().get("tracks") or {}).get("items") or []
            for t in search_items:
                _accept(t)
            if len(search_items) < batch:
                break
            if len(items) >= limit:
                break

    if rejected:
        print(
            f"track_populator: '{artist_name}' — kept {len(items)}, dropped "
            f"{rejected} track(s) not credited to this artist",
            flush=True,
        )

    if not items:
        return 0, None

    # Album-sourced tracks arrive without popularity; recover it before the
    # upsert so the ranker has a within-catalog quality signal.
    _hydrate_track_popularity(client, headers, items)

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

    retry_on_disconnect(
        lambda: (
            admin_supabase.table("tracks")
            .upsert(rows, on_conflict="spotify_track_id")
            .execute()
        ),
        attempts=3,
    )

    return len(rows), None
