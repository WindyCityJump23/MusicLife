"""Remove stored tracks that an artist did not actually perform.

The attribution fix stops new bad rows, and the attribution audit verifies
stored ones — but the audit costs one Spotify request *per track*, which a
Development Mode quota cannot absorb across a full catalog.

This job asks the cheaper question. Instead of "is this stored track really
theirs?", it asks "what does Spotify say this artist's catalog actually is?"
— one answer covers every row filed under them, at roughly 7 requests per
artist instead of one per track. Anything stored under the artist that is
absent from their verified catalog is misattributed.

The cheap pass only produces *candidates*. Absence from an artist's album
list is NOT evidence that a track is not theirs: side projects and
collaborations are filed under a different album artist, so
/v1/artists/{id}/albums never returns them. Two deadmau5 tracks released as
Kx5 (deadmau5 + Kaskade) were flagged by an early version of this job and
are genuinely his — 2 of 6 spot-checks were false positives. Every candidate
is therefore confirmed with a per-track credits lookup before deletion,
which is bounded by the candidate count rather than the catalog size.

Safety
------
Three rules keep this from deleting real music:

* **Per-track confirmation.** A candidate is only deletable once
  ``/v1/tracks/{id}`` shows its own credits exclude the artist.

* **Truncation guard.** ``fetch_verified_tracks`` stops at ``limit``. A result
  that reaches the cap may be a partial view of a deep catalog, so absence
  proves nothing and the artist is skipped entirely. Only artists whose whole
  catalog was enumerated are pruned.
* **Library guard.** ``user_tracks.track_id`` is ON DELETE CASCADE, so
  deleting a track destroys the listener's own library or history row. Those
  are never deleted; they are reported instead.

Dry run by default. Nothing is deleted unless ``apply=True``.
"""

from __future__ import annotations

import time
from typing import Callable

import httpx

from app.services.supabase_client import admin_supabase, retry_on_disconnect
from app.services.track_populator import (
    TRACKS_PER_ARTIST,
    SpotifyAuthError,
    fetch_full_tracks,
    fetch_verified_tracks,
    track_credits_artist,
)


def run_catalog_prune(
    access_token: str,
    artist_ids: list[int] | None = None,
    limit: int | None = None,
    apply: bool = False,
    progress: Callable[[str], None] | None = None,
    request_budget: int | None = None,
) -> dict:
    """Compare stored tracks against each artist's verified Spotify catalog.

    Args:
        access_token: any valid Spotify token (reads /albums and /search).
        artist_ids: restrict to these artists; None sweeps every artist that
            has stored tracks.
        limit: cap the number of artists examined.
        apply: delete the misattributed rows. Default False (report only).
        request_budget: stop cleanly after roughly this many Spotify
            requests, so a run cannot exhaust a Development Mode quota and
            take the live app's search down with it.

    Returns a summary with per-artist detail.
    """
    artists = _load_artists(artist_ids)
    if limit is not None:
        artists = artists[: max(0, limit)]
    total = len(artists)
    print(f"catalog_prune: {total} artists to examine (apply={apply})", flush=True)
    if progress:
        progress(f"Checking artist catalogs (0/{total})")
    if not total:
        return {"artists_examined": 0, "misattributed": 0, "deleted": 0}

    headers = {"Authorization": f"Bearer {access_token}"}
    spent = 0
    examined = 0
    skipped_truncated = 0
    errors = 0
    findings: list[dict] = []
    protected: list[dict] = []
    budget_hit = False

    with httpx.Client(timeout=25) as client:
        for index, artist in enumerate(artists):
            if request_budget is not None and spent >= request_budget:
                budget_hit = True
                print(
                    f"catalog_prune: request budget reached after {examined} artists; "
                    "stopping cleanly",
                    flush=True,
                )
                break

            try:
                verified, error = fetch_verified_tracks(
                    client, headers, artist, TRACKS_PER_ARTIST
                )
            except SpotifyAuthError as exc:
                return _error_summary(examined, findings, protected, errors,
                                      f"{exc}. Sign out and back in, then re-run.")
            except Exception as exc:  # transport, malformed payload
                errors += 1
                print(f"catalog_prune: {artist['name']!r} failed: {exc}", flush=True)
                continue

            # Roughly what fetch_verified_tracks costs: one albums call plus
            # per-album track calls, or search pages. Close enough to pace a
            # budget without threading a counter through the populator.
            spent += 7

            if error:
                errors += 1
                if "rate limit" in error.lower() or "429" in error:
                    print(f"catalog_prune: rate limited — stopping. {error}", flush=True)
                    budget_hit = True
                    break
                continue

            if len(verified) >= TRACKS_PER_ARTIST:
                # Catalog may be truncated: absence is not evidence.
                skipped_truncated += 1
                continue

            examined += 1
            verified_ids = {t.get("id") for t in verified if t.get("id")}
            stored = _stored_tracks(artist["id"])
            orphans = [
                row for row in stored
                if row.get("spotify_track_id")
                and row["spotify_track_id"] not in verified_ids
            ]
            if orphans:
                library_ids = _library_track_ids([r["id"] for r in orphans])
                for row in orphans:
                    record = {
                        "track_id": row["id"],
                        "track_name": row.get("name"),
                        "spotify_track_id": row.get("spotify_track_id"),
                        "filed_under": artist["name"],
                        "artist_id": artist["id"],
                        "artist_spotify_id": artist.get("spotify_artist_id"),
                    }
                    if row["id"] in library_ids:
                        protected.append(record)
                    else:
                        findings.append(record)

            if progress and index % 10 == 0:
                progress(f"Checking artist catalogs ({index + 1}/{total})")
            # The populator paces itself the same way between artists.
            time.sleep(1.0)

    # Confirm every candidate against its own credits before deleting.
    confirmed, cleared = _confirm_candidates(findings, access_token, progress)

    deleted = 0
    if apply and confirmed:
        deleted = _delete_tracks([f["track_id"] for f in confirmed], progress)

    summary = {
        "artists_examined": examined,
        "artists_skipped_truncated": skipped_truncated,
        "candidates": len(findings),
        "misattributed": len(confirmed),
        "cleared_by_confirmation": len(cleared),
        "protected_by_library": len(protected),
        "deleted": deleted,
        "errors": errors,
        "applied": apply,
        "stopped_early": budget_hit,
        "approx_requests": spent + len(findings),
        "findings": confirmed,
        "cleared": cleared,
        "protected": protected,
    }
    print(
        f"catalog_prune: {len(findings)} candidates across {examined} artists -> "
        f"{len(confirmed)} confirmed misattributed, {len(cleared)} cleared by "
        f"per-track check ({skipped_truncated} artists skipped as truncated, "
        f"{len(protected)} protected), {deleted} deleted",
        flush=True,
    )
    return summary


def _error_summary(examined, findings, protected, errors, message) -> dict:
    return {
        "artists_examined": examined,
        "misattributed": len(findings),
        "protected_by_library": len(protected),
        "deleted": 0,
        "errors": errors + 1,
        "findings": findings,
        "protected": protected,
        "error": message,
    }


def _load_artists(artist_ids: list[int] | None) -> list[dict]:
    rows: list[dict] = []
    offset, page = 0, 1000
    while True:
        query = (
            admin_supabase.table("artists")
            .select("id,name,spotify_artist_id")
            .not_.is_("spotify_artist_id", "null")
        )
        if artist_ids:
            query = query.in_("id", artist_ids)
        resp = retry_on_disconnect(
            lambda q=query, o=offset: q.range(o, o + page - 1).execute(), attempts=3
        )
        batch = resp.data or []
        rows.extend(r for r in batch if r.get("name"))
        if len(batch) < page:
            break
        offset += page
    return rows


def _stored_tracks(artist_id: int) -> list[dict]:
    resp = retry_on_disconnect(
        lambda: (
            admin_supabase.table("tracks")
            .select("id,name,spotify_track_id")
            .eq("artist_id", artist_id)
            .range(0, 9999)
            .execute()
        ),
        attempts=3,
    )
    return resp.data or []


def _library_track_ids(track_ids: list[int]) -> set[int]:
    """Which of these are referenced by user_tracks (ON DELETE CASCADE)."""
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
                lambda c=chunk: admin_supabase.table("tracks").delete().in_("id", c).execute(),
                attempts=3,
            )
            deleted += len(chunk)
            if progress:
                progress(f"Removing misattributed tracks ({deleted}/{len(track_ids)})")
        except Exception as exc:
            print(f"catalog_prune: delete failed for a chunk: {exc}", flush=True)
    return deleted


def _confirm_candidates(
    candidates: list[dict],
    access_token: str,
    progress: Callable[[str], None] | None = None,
) -> tuple[list[dict], list[dict]]:
    """Re-check each candidate against its own Spotify credits.

    The cheap pass asks what an artist's albums contain, which misses
    collaborations and side-project releases. This asks the authoritative
    question for the far smaller candidate set. Anything the per-track check
    vindicates is returned as cleared and must not be deleted.
    """
    if not candidates:
        return [], []

    confirmed: list[dict] = []
    cleared: list[dict] = []
    headers = {"Authorization": f"Bearer {access_token}"}
    with_ids = [c for c in candidates if c.get("spotify_track_id")]

    if progress:
        progress(f"Confirming {len(with_ids)} candidates")

    with httpx.Client(timeout=25) as client:
        for start in range(0, len(with_ids), 50):
            chunk = with_ids[start : start + 50]
            try:
                fetched = fetch_full_tracks(
                    client, headers, [c["spotify_track_id"] for c in chunk]
                )
            except SpotifyAuthError:
                # Unverified candidates are never deletable.
                cleared.extend(chunk[len(confirmed):])
                break
            for cand in chunk:
                full = fetched.get(cand["spotify_track_id"])
                if full is None:
                    # No verdict available: leave it alone.
                    cleared.append(cand)
                elif track_credits_artist(
                    full, cand.get("artist_spotify_id") or "", cand.get("filed_under") or ""
                ):
                    cand["actual_artists"] = [
                        a.get("name") for a in (full.get("artists") or []) if isinstance(a, dict)
                    ]
                    cleared.append(cand)
                else:
                    cand["actual_artists"] = [
                        a.get("name") for a in (full.get("artists") or []) if isinstance(a, dict)
                    ]
                    confirmed.append(cand)
            if progress and (start // 50) % 5 == 0:
                progress(f"Confirming candidates ({start + len(chunk)}/{len(with_ids)})")
    return confirmed, cleared
