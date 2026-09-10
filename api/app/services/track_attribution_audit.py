"""Find and remove tracks filed under an artist who did not perform them.

``track_populator`` used to keep whatever Spotify returned for an artist and
write it with that artist's ``artist_id``, without ever reading the track's own
``artists`` credits. Two paths produced wrong rows:

  * the albums walk kept *every* track on an album the artist was credited on,
    so one guest verse filed an entire compilation under them; and
  * the search top-up used ``artist:"Name"``, a fuzzy text filter, and padded
    small catalogs up to the 50-track quota with music by whoever else matched
    the string.

The ingest fix stops new bad rows. This job repairs what is already stored: it
re-reads each track from Spotify and drops the ones whose credits do not
include the artist they are filed under.

Safety
------
``user_tracks.track_id`` cascades on delete, so removing a track would delete
the user's own library row and corrupt their taste profile. Tracks referenced
from ``user_tracks`` are therefore never deleted — they are counted and
reported for manual review instead. Every other foreign key is ON DELETE SET
NULL, so removing an orphan track loses at most a history linkage.

Dry run by default. Nothing is deleted unless ``apply=True``.
"""

from __future__ import annotations

import time
from typing import Callable

import httpx

from app.services.supabase_client import admin_supabase, retry_on_disconnect
from app.services.track_populator import fetch_full_tracks, track_credits_artist

# Spotify's /v1/tracks accepts up to 50 ids per request.
_SPOTIFY_BATCH = 50


def run_track_attribution_audit(
    access_token: str,
    limit: int | None = None,
    apply: bool = False,
    progress: Callable[[str], None] | None = None,
) -> dict:
    """Verify stored tracks against Spotify's own artist credits.

    Args:
        access_token: any valid Spotify token (this only reads /v1/tracks).
        limit: cap the number of tracks examined; None audits the catalog.
        apply: delete the misattributed rows. Default False (report only).

    Returns a summary with counts plus a sample of what was found.
    """
    candidates = _load_candidates(limit)
    total = len(candidates)
    print(f"track_attribution_audit: examining {total} tracks (apply={apply})", flush=True)
    if progress:
        progress(f"Checking track credits (0/{total})")
    if not total:
        return {"examined": 0, "misattributed": 0, "deleted": 0, "protected": 0, "errors": 0}

    by_spotify_id = {
        row["spotify_track_id"]: row
        for row in candidates
        if row.get("spotify_track_id")
    }
    ordered_ids = list(by_spotify_id.keys())

    misattributed: list[dict] = []
    unknown = 0
    errors = 0
    examined = 0

    headers = {"Authorization": f"Bearer {access_token}"}
    with httpx.Client(timeout=20) as client:
        for start in range(0, len(ordered_ids), _SPOTIFY_BATCH):
            chunk = ordered_ids[start : start + _SPOTIFY_BATCH]
            # Batch-with-single-fallback: the batch /v1/tracks endpoint is 403
            # for some app credentials even when single lookups on the same
            # token succeed, and a batch-only audit would silently examine
            # nothing and report a clean catalog.
            fetched = fetch_full_tracks(client, headers, chunk)
            if not fetched:
                errors += 1
                if errors > 20:
                    break
                continue

            for spotify_id, full in fetched.items():
                row = by_spotify_id.get(spotify_id)
                if not row:
                    continue
                examined += 1
                if not track_credits_artist(
                    full,
                    row.get("artist_spotify_id") or "",
                    row.get("artist_name") or "",
                ):
                    misattributed.append({
                        "track_id": row["id"],
                        "track_name": row.get("name"),
                        "filed_under": row.get("artist_name"),
                        "actual_artists": [
                            a.get("name")
                            for a in (full.get("artists") or [])
                            if isinstance(a, dict)
                        ],
                        "album_name": (full.get("album") or {}).get("name"),
                    })

            # Spotify returns nothing for ids it cannot resolve (region pulls,
            # takedowns). No credits means no verdict, so they are counted
            # rather than treated as misattributed.
            unknown += len(chunk) - len(fetched)

            if progress and (start // _SPOTIFY_BATCH) % 10 == 0:
                progress(f"Checking track credits ({examined}/{total})")
            time.sleep(0.1)

    protected_ids = _library_track_ids([m["track_id"] for m in misattributed])
    deletable = [m for m in misattributed if m["track_id"] not in protected_ids]
    protected = len(misattributed) - len(deletable)
    for finding in misattributed:
        finding["in_user_library"] = finding["track_id"] in protected_ids

    deleted = 0
    if apply and deletable:
        deleted = _delete_tracks([m["track_id"] for m in deletable], progress)

    summary = {
        "examined": examined,
        "misattributed": len(misattributed),
        "deletable": len(deletable),
        "protected": protected,
        "deleted": deleted,
        "unresolved": unknown,
        "errors": errors,
        "applied": apply,
        "findings": misattributed,
    }
    print(
        f"track_attribution_audit: {summary['misattributed']}/{examined} misattributed, "
        f"{protected} protected by user_tracks, {deleted} deleted",
        flush=True,
    )
    return summary


def _load_candidates(limit: int | None) -> list[dict]:
    """Tracks joined to the artist they are filed under."""
    rows: list[dict] = []
    offset = 0
    page = 1000
    while True:
        resp = retry_on_disconnect(
            lambda o=offset: (
                admin_supabase.table("tracks")
                .select("id,name,spotify_track_id,artist_id,artists(name,spotify_artist_id)")
                .not_.is_("spotify_track_id", "null")
                .range(o, o + page - 1)
                .execute()
            ),
            attempts=3,
        )
        batch = resp.data or []
        for row in batch:
            artist = row.get("artists")
            if isinstance(artist, list):
                artist = artist[0] if artist else None
            if not isinstance(artist, dict):
                continue
            rows.append({
                "id": row["id"],
                "name": row.get("name"),
                "spotify_track_id": row.get("spotify_track_id"),
                "artist_name": artist.get("name"),
                "artist_spotify_id": artist.get("spotify_artist_id"),
            })
        if len(batch) < page:
            break
        offset += page
        if limit is not None and len(rows) >= limit:
            break

    if limit is not None:
        rows = rows[: max(0, limit)]
    return rows


def _library_track_ids(track_ids: list[int]) -> set[int]:
    """Which of ``track_ids`` are referenced by user_tracks.

    Scoped to the candidates rather than scanning the whole table, so a small
    report run stays fast. These are the rows that must never be deleted:
    user_tracks.track_id is ON DELETE CASCADE, so removing one would delete
    the user's own library row.
    """
    ids: set[int] = set()
    if not track_ids:
        return ids
    for start in range(0, len(track_ids), 200):
        chunk = track_ids[start : start + 200]
        resp = retry_on_disconnect(
            lambda c=chunk: (
                admin_supabase.table("user_tracks")
                .select("track_id")
                .in_("track_id", c)
                .range(0, 9999)
                .execute()
            ),
            attempts=3,
        )
        for row in resp.data or []:
            if row.get("track_id") is not None:
                ids.add(int(row["track_id"]))
    return ids


def _delete_tracks(track_ids: list[int], progress: Callable[[str], None] | None) -> int:
    deleted = 0
    for start in range(0, len(track_ids), 200):
        chunk = track_ids[start : start + 200]
        try:
            retry_on_disconnect(
                lambda c=chunk: (
                    admin_supabase.table("tracks").delete().in_("id", c).execute()
                ),
                attempts=3,
            )
            deleted += len(chunk)
            if progress:
                progress(f"Removing misattributed tracks ({deleted}/{len(track_ids)})")
        except Exception as exc:
            print(f"track_attribution_audit: delete failed for a chunk: {exc}", flush=True)
    return deleted
