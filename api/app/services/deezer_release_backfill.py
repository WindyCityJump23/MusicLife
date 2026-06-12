"""Backfill missing track release dates from the Deezer public API.

~24% of playable tracks have release_date NULL, which blinds the freshness
signals (new-release bonus, the radio_hits is_newish gate, the freshness
strategy multiplier). Deezer's API is free and unauthenticated and exposes
album release dates.

Matching is deliberately strict — a wrong date is worse than no date:
the normalized artist name must match exactly and the normalized title must
match exactly or be a clean prefix (handles "Song - Remastered" suffixes).
Ambiguous candidates are skipped and counted.
"""

from __future__ import annotations

import re
import time
import unicodedata
from typing import Callable

import httpx

from app.services.supabase_client import admin_supabase

_DEEZER_SEARCH = "https://api.deezer.com/search"
_DEEZER_ALBUM = "https://api.deezer.com/album/{id}"
# Deezer allows 50 requests per 5 seconds; stay well under it.
_SLEEP_EVERY = 4
_SLEEP_SECONDS = 0.5
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.lower()
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return " ".join(text.split())


def run_deezer_release_backfill(
    limit: int | None = None,
    progress: Callable[[str], None] | None = None,
) -> dict:
    """Fill tracks.release_date from Deezer for rows missing it. Returns summary."""

    candidates: list[dict] = []
    offset = 0
    page_size = 500

    while True:
        resp = (
            admin_supabase.table("tracks")
            .select("id,name,artist_id,artists(name)")
            .is_("release_date", "null")
            .not_.is_("spotify_track_id", "null")
            .range(offset, offset + page_size - 1)
            .execute()
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
    print(f"deezer_release_backfill: {total} tracks missing release dates")
    if progress:
        progress(f"Backfilling release dates (0/{total})")

    updated = 0
    skipped_ambiguous = 0
    not_found = 0
    errors = 0
    last_error: str | None = None
    album_date_cache: dict[int, str | None] = {}
    request_count = 0

    def _throttle() -> None:
        nonlocal request_count
        request_count += 1
        if request_count % _SLEEP_EVERY == 0:
            time.sleep(_SLEEP_SECONDS)

    with httpx.Client(timeout=10) as client:
        for i, track in enumerate(candidates):
            artist_obj = track.get("artists")
            if isinstance(artist_obj, list):
                artist_obj = artist_obj[0] if artist_obj else None
            artist_name = (artist_obj or {}).get("name") if isinstance(artist_obj, dict) else None
            track_name = track.get("name")
            if not artist_name or not track_name:
                not_found += 1
                continue

            try:
                release_date = _lookup_release_date(
                    client, artist_name, track_name, album_date_cache, _throttle
                )
                if release_date == "ambiguous":
                    skipped_ambiguous += 1
                elif release_date:
                    admin_supabase.table("tracks").update(
                        {"release_date": release_date}
                    ).eq("id", track["id"]).execute()
                    updated += 1
                else:
                    not_found += 1

                if (i + 1) % 100 == 0:
                    print(
                        f"deezer_release_backfill: {i + 1}/{total} processed, "
                        f"{updated} updated, {skipped_ambiguous} ambiguous"
                    )
                    if progress:
                        progress(f"Backfilling release dates ({i + 1}/{total})")

            except Exception as exc:
                errors += 1
                last_error = str(exc)[:200]
                if errors > 30:
                    print(f"deezer_release_backfill: too many errors ({errors}), stopping")
                    break
                time.sleep(1)

    summary: dict = {
        "total": total,
        "updated": updated,
        "skipped_ambiguous": skipped_ambiguous,
        "not_found": not_found,
        "errors": errors,
    }
    if last_error:
        summary["last_error"] = last_error
    print(f"deezer_release_backfill: done — {summary}")
    return summary


def _lookup_release_date(
    client: httpx.Client,
    artist_name: str,
    track_name: str,
    album_date_cache: dict[int, str | None],
    throttle: Callable[[], None],
) -> str | None:
    """Return an ISO date, 'ambiguous' when matches conflict, or None."""
    resp = client.get(
        _DEEZER_SEARCH,
        params={"q": f'artist:"{artist_name}" track:"{track_name}"', "limit": 5},
    )
    throttle()
    if resp.status_code != 200:
        return None
    results = (resp.json() or {}).get("data") or []
    if not results:
        return None

    want_artist = _normalize(artist_name)
    want_title = _normalize(track_name)

    matches = []
    for hit in results:
        hit_artist = _normalize((hit.get("artist") or {}).get("name") or "")
        hit_title = _normalize(hit.get("title") or "")
        if hit_artist != want_artist:
            continue
        # Exact title, or clean prefix in either direction (remaster suffixes).
        if hit_title == want_title or hit_title.startswith(want_title) or want_title.startswith(hit_title):
            album_id = (hit.get("album") or {}).get("id")
            if album_id:
                matches.append(int(album_id))

    if not matches:
        return None

    dates: set[str] = set()
    for album_id in matches[:3]:
        if album_id not in album_date_cache:
            album_resp = client.get(_DEEZER_ALBUM.format(id=album_id))
            throttle()
            date = None
            if album_resp.status_code == 200:
                raw = (album_resp.json() or {}).get("release_date")
                if isinstance(raw, str) and _DATE_RE.match(raw) and not raw.startswith("0000"):
                    date = raw
            album_date_cache[album_id] = date
        if album_date_cache[album_id]:
            dates.add(album_date_cache[album_id])  # type: ignore[arg-type]

    if not dates:
        return None
    if len(dates) == 1:
        return next(iter(dates))
    # Conflicting album dates (original vs remaster/compilation): take the
    # earliest — first release is what freshness signals care about.
    return min(dates)
