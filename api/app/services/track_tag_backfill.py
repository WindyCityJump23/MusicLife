"""Fetch Last.fm track-level tags and refresh the track embedding source.

For each track we have an artist for, call Last.fm ``track.getTopTags``
to retrieve user-contributed descriptors ("chill", "melancholy", "summer
driving") and:

  1. Store them in ``tracks.tags``.
  2. Rebuild ``tracks.embedding_source`` to include the tags so the next
     embedding pass captures the track's mood/feel, not just artist +
     title + album.
  3. Null out ``tracks.embedding`` so the embed worker re-embeds it.

This is rate-limited (Last.fm allows ~5 req/s) and idempotent: tracks
that already have non-empty tags are skipped unless ``refresh=True`` is
passed.
"""

from __future__ import annotations

import time

import httpx

from app.config import settings
from app.services.supabase_client import admin_supabase

# Tags we never want to keep — they're either administrative ("seen
# live"), preference markers ("favorites"), or service noise ("spotify").
TAG_BLOCKLIST = {
    "seen live",
    "favorites",
    "favorite",
    "favourite",
    "favourites",
    "spotify",
    "check",
    "check out",
    "albums i own",
    "songs i love",
    "tracks i like",
    "my music",
    "best",
    "awesome",
    "good",
    "great",
    "amazing",
    "love",
    "love it",
    "loved",
    "cool",
    "nice",
    "perfect",
    "yes",
    "wow",
}

MAX_TAGS_PER_TRACK = 8


def run_track_tag_backfill(refresh: bool = False, limit: int | None = None) -> dict:
    """Backfill Last.fm tags for tracks. Returns summary stats.

    Args:
        refresh: If True, re-fetch tags even for tracks that already
            have some. Useful after the blocklist changes.
        limit: Optional cap on how many tracks to process this run.
    """
    print(f"track_tags: starting (refresh={refresh}, limit={limit})", flush=True)

    candidates = _fetch_candidates(refresh=refresh, hard_limit=limit)
    print(f"track_tags: {len(candidates)} candidate tracks", flush=True)
    if not candidates:
        return {"total": 0, "updated": 0, "errors": 0}

    artist_names = _fetch_artist_names(
        sorted({c["artist_id"] for c in candidates if c.get("artist_id")})
    )

    updated = 0
    skipped_no_tags = 0
    errors = 0
    last_error: str | None = None

    with httpx.Client(timeout=10) as client:
        for i, track in enumerate(candidates):
            artist_id = track.get("artist_id")
            artist_name = artist_names.get(int(artist_id)) if artist_id else None
            track_name = track.get("name")
            if not artist_name or not track_name:
                continue

            try:
                tags = _fetch_track_tags(client, artist_name, track_name)
                if not tags:
                    skipped_no_tags += 1
                else:
                    new_source = _compose_embedding_source(
                        artist_name=artist_name,
                        track_name=track_name,
                        album_name=track.get("album_name"),
                        tags=tags,
                    )
                    admin_supabase.table("tracks").update(
                        {
                            "tags": tags,
                            "embedding_source": new_source,
                            "embedding": None,
                        }
                    ).eq("id", track["id"]).execute()
                    updated += 1

                # Last.fm is happy with ~5 req/s. Sleep every 4 calls.
                if (i + 1) % 4 == 0:
                    time.sleep(0.3)

                if (i + 1) % 100 == 0:
                    print(
                        f"track_tags: {i + 1}/{len(candidates)} processed, "
                        f"{updated} updated, {skipped_no_tags} no-tags, "
                        f"{errors} errors",
                        flush=True,
                    )
            except Exception as exc:
                errors += 1
                last_error = f"{type(exc).__name__}: {exc}"[:200]
                if errors > 30:
                    print(f"track_tags: too many errors ({errors}), stopping", flush=True)
                    break
                time.sleep(1)

    summary: dict = {
        "total": len(candidates),
        "updated": updated,
        "no_tags": skipped_no_tags,
        "errors": errors,
    }
    if last_error:
        summary["last_error"] = last_error
    print(f"track_tags: done — {summary}", flush=True)
    return summary


def _fetch_candidates(refresh: bool, hard_limit: int | None) -> list[dict]:
    rows: list[dict] = []
    offset = 0
    page_size = 1000
    while True:
        q = (
            admin_supabase.table("tracks")
            .select("id, name, album_name, artist_id, tags")
            .not_.is_("artist_id", "null")
            .range(offset, offset + page_size - 1)
        )
        resp = q.execute()
        page = resp.data or []
        for r in page:
            if not refresh and (r.get("tags") or []):
                continue
            rows.append(r)
            if hard_limit is not None and len(rows) >= hard_limit:
                return rows
        if len(page) < page_size:
            break
        offset += page_size
    return rows


def _fetch_artist_names(artist_ids: list[int]) -> dict[int, str]:
    """Bulk-load artist names for the given ids."""
    if not artist_ids:
        return {}
    out: dict[int, str] = {}
    # Supabase .in_ has a practical URL limit; chunk to be safe.
    CHUNK = 200
    for i in range(0, len(artist_ids), CHUNK):
        chunk = artist_ids[i : i + CHUNK]
        resp = (
            admin_supabase.table("artists")
            .select("id, name")
            .in_("id", chunk)
            .execute()
        )
        for a in resp.data or []:
            if a.get("id") is not None and a.get("name"):
                out[int(a["id"])] = a["name"]
    return out


def _fetch_track_tags(
    client: httpx.Client, artist: str, track: str
) -> list[str]:
    """Fetch top tags for a single track from Last.fm."""
    resp = client.get(
        "https://ws.audioscrobbler.com/2.0/",
        params={
            "method": "track.getTopTags",
            "artist": artist,
            "track": track,
            "api_key": settings.lastfm_api_key,
            "autocorrect": 1,
            "format": "json",
        },
    )
    if resp.status_code != 200:
        return []
    data = resp.json()
    if "error" in data:
        return []
    raw = (data.get("toptags") or {}).get("tag") or []
    out: list[str] = []
    seen: set[str] = set()
    for t in raw:
        name = (t.get("name") or "").strip().lower()
        if not name or name in TAG_BLOCKLIST or name in seen:
            continue
        # Drop tags that are pure numbers or single characters.
        if len(name) < 2 or name.isdigit():
            continue
        seen.add(name)
        out.append(name)
        if len(out) >= MAX_TAGS_PER_TRACK:
            break
    return out


def _compose_embedding_source(
    artist_name: str | None,
    track_name: str | None,
    album_name: str | None,
    tags: list[str] | None,
) -> str:
    """Compose ``tracks.embedding_source`` including descriptive tags.

    Format::

        "{artist} – {title} – {album} | tags: t1, t2, t3"

    The ``tags:`` prefix tells the embedding model the trailing tokens
    are descriptors, not part of the title.
    """
    parts = [
        (artist_name or "").strip(),
        (track_name or "").strip(),
        (album_name or "").strip(),
    ]
    parts = [p for p in parts if p]
    base = " – ".join(parts)
    if tags:
        base = f"{base} | tags: {', '.join(tags)}"
    return base
