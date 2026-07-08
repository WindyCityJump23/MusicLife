"""Per-track Last.fm tags — song-level semantics for prompt matching.

Track embeddings were built from "artist – title – album" text only, so a
prompt like "sad night drive" matched mostly through artist-level context.
Last.fm's track.getTopTags supplies track-level mood/style tags; this job
fetches them, folds them into tracks.embedding_source, and clears the track's
embedding so the standard embedding job re-embeds it with the deeper text.

Resumable by construction: only rows with lastfm_tags IS NULL are selected.
Tracks with no tags on Last.fm are marked with [] (visited, not re-embedded).
"""

from __future__ import annotations

import time
from typing import Callable

import httpx

from app.config import settings
from app.services.supabase_client import admin_supabase, retry_on_disconnect
from app.services.track_embeddings import _build_embedding_source

# Generic tags that add no semantic value to an embedding.
_SKIP_TAGS = {"seen live", "favorites", "favorite", "spotify", "check", "mylibrary"}
_MAX_TAGS = 8


def run_track_tags_backfill(
    limit: int | None = 2000,
    progress: Callable[[str], None] | None = None,
) -> dict:
    """Fetch Last.fm tags for tracks missing them. Returns summary."""

    candidates: list[dict] = []
    offset = 0
    page_size = 500

    while True:
        resp = retry_on_disconnect(
            lambda o=offset: (
                admin_supabase.table("tracks")
                .select("id,name,album_name,artist_id,artists(name)")
                .is_("lastfm_tags", "null")
                .not_.is_("spotify_track_id", "null")
                .range(o, o + page_size - 1)
                .execute()
            ),
            attempts=3,
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
    print(f"track_tags_backfill: {total} tracks need tags")
    if progress:
        progress(f"Fetching track tags (0/{total})")

    tagged = 0
    untagged = 0
    errors = 0
    last_error: str | None = None

    with httpx.Client(timeout=10) as client:
        for i, track in enumerate(candidates):
            artist_obj = track.get("artists")
            if isinstance(artist_obj, list):
                artist_obj = artist_obj[0] if artist_obj else None
            artist_name = (artist_obj or {}).get("name") if isinstance(artist_obj, dict) else None
            track_name = track.get("name")
            if not artist_name or not track_name:
                untagged += 1
                _mark_visited(track["id"], [])
                continue

            try:
                tags = _fetch_track_tags(client, artist_name, track_name)
                if tags:
                    # Rebuild the embedding text with tags and clear the
                    # vector so the standard embedding job re-embeds it.
                    new_source = _build_embedding_source(
                        artist_name=artist_name,
                        track_name=track_name,
                        album_name=track.get("album_name"),
                        tags=tags,
                    )
                    retry_on_disconnect(
                        lambda t=track, s=new_source, tg=tags: (
                            admin_supabase.table("tracks")
                            .update({
                                "lastfm_tags": tg,
                                "embedding_source": s,
                                "embedding": None,
                            })
                            .eq("id", t["id"])
                            .execute()
                        ),
                        attempts=3,
                    )
                    tagged += 1
                else:
                    _mark_visited(track["id"], [])
                    untagged += 1

                # Last.fm rate limit: ~5 req/s is safe.
                if (i + 1) % 4 == 0:
                    time.sleep(0.3)

                if (i + 1) % 200 == 0:
                    print(f"track_tags_backfill: {i + 1}/{total}, {tagged} tagged")
                    if progress:
                        progress(f"Fetching track tags ({i + 1}/{total})")

            except Exception as exc:
                errors += 1
                last_error = str(exc)[:200]
                if errors > 30:
                    print(f"track_tags_backfill: too many errors ({errors}), stopping")
                    break
                time.sleep(1)

    summary: dict = {"total": total, "tagged": tagged, "untagged": untagged, "errors": errors}
    if last_error:
        summary["last_error"] = last_error
    print(f"track_tags_backfill: done — {summary}")
    return summary


def _mark_visited(track_id: int, tags: list[str]) -> None:
    try:
        retry_on_disconnect(
            lambda: (
                admin_supabase.table("tracks")
                .update({"lastfm_tags": tags})
                .eq("id", track_id)
                .execute()
            ),
            attempts=3,
        )
    except Exception as exc:
        print(f"track_tags_backfill: could not mark track {track_id}: {exc}")


def _fetch_track_tags(client: httpx.Client, artist: str, track: str) -> list[str]:
    resp = client.get(
        "https://ws.audioscrobbler.com/2.0/",
        params={
            "method": "track.getTopTags",
            "artist": artist,
            "track": track,
            "api_key": settings.lastfm_api_key,
            "format": "json",
            "autocorrect": 1,
        },
    )
    if resp.status_code != 200:
        return []
    data = resp.json()
    if "error" in data:
        return []
    tags = (data.get("toptags") or {}).get("tag") or []
    return [
        t["name"].lower()
        for t in tags[:15]
        if t.get("name") and t["name"].lower() not in _SKIP_TAGS
    ][:_MAX_TAGS]
