"""Catalog expansion via Last.fm similar artists.

For each artist in the DB, fetches their similar artists from Last.fm
and creates new artist rows. This expands the catalog outward from the
user's taste — similar artists to artists they already listen to.

Pipeline:
  1. Fetch all existing artists with names
  2. For each, call Last.fm artist.getSimilar (up to 10 similar)
  3. Deduplicate against existing artists (by name, case-insensitive)
  4. Insert new artist rows with genres from Last.fm tags
  5. After expansion, the caller should run:
     - Enrichment (to get bios/embedding_source)
     - Embedding generation
     - Track population
"""

from __future__ import annotations

import time
from collections import defaultdict

import httpx

from app.config import settings
from app.services.supabase_client import admin_supabase


SIMILAR_PER_ARTIST = 8  # How many similar artists to fetch per seed
MAX_SEED_ARTISTS = 500  # Cap on how many seed artists to process


def run_catalog_expansion() -> dict:
    """Expand the catalog via Last.fm similar artists. Returns summary."""

    # 1. Load existing artists (by name for dedup)
    existing_names = _load_existing_artist_names()
    print(f"catalog_expansion: {len(existing_names)} existing artists")

    # 2. Load seed artists (prioritize library artists, then discovered ones)
    seeds = _load_seed_artists()
    print(f"catalog_expansion: {len(seeds)} seed artists to expand from")

    # 3. Fetch similar artists for each seed
    new_artists: dict[str, dict] = {}  # name_lower -> artist data
    errors = 0
    last_error = None

    with httpx.Client(timeout=10) as client:
        for i, seed in enumerate(seeds[:MAX_SEED_ARTISTS]):
            try:
                similars = _fetch_similar_artists(client, seed["name"])

                for similar in similars[:SIMILAR_PER_ARTIST]:
                    name = similar.get("name", "").strip()
                    if not name:
                        continue
                    name_lower = name.lower()

                    # Skip if already exists or already queued
                    if name_lower in existing_names:
                        continue
                    if name_lower in new_artists:
                        # Merge: increment the "discovered from" count
                        new_artists[name_lower]["_source_count"] += 1
                        continue

                    new_artists[name_lower] = {
                        "name": name,
                        "genres": similar.get("tags", [])[:8],
                        "_source_count": 1,
                        "_seed": seed["name"],
                    }

                # Rate limit: Last.fm allows ~5 req/s
                if (i + 1) % 4 == 0:
                    time.sleep(0.25)

                if (i + 1) % 50 == 0:
                    print(f"catalog_expansion: {i+1}/{len(seeds)} seeds processed, "
                          f"{len(new_artists)} new artists found so far")

            except Exception as exc:
                errors += 1
                last_error = str(exc)[:200]
                if errors > 30:
                    print(f"catalog_expansion: too many errors ({errors}), stopping seed loop")
                    break
                time.sleep(1)

    print(f"catalog_expansion: found {len(new_artists)} new unique artists from {len(seeds)} seeds")

    if not new_artists:
        return {"seeds": len(seeds), "new_artists": 0, "inserted": 0, "errors": errors}

    # 4. Insert new artists in batches
    inserted = 0
    batch_size = 50
    artist_list = list(new_artists.values())

    for batch_start in range(0, len(artist_list), batch_size):
        batch = artist_list[batch_start:batch_start + batch_size]
        rows = [
            {
                "name": a["name"],
                "genres": a.get("genres") or [],
            }
            for a in batch
        ]

        try:
            # Use upsert with name conflict to avoid duplicates
            # (some names might have been added between our check and insert)
            admin_supabase.table("artists").upsert(
                rows, on_conflict="name"
            ).execute()
            inserted += len(rows)
        except Exception as exc:
            # If upsert by name fails (no unique constraint on name),
            # fall back to individual inserts
            for row in rows:
                try:
                    # Check if exists
                    check = (
                        admin_supabase.table("artists")
                        .select("id")
                        .ilike("name", row["name"])
                        .limit(1)
                        .execute()
                    )
                    if not (check.data or []):
                        admin_supabase.table("artists").insert(row).execute()
                        inserted += 1
                except Exception:
                    pass  # Skip duplicates

        if batch_start % 200 == 0 and batch_start > 0:
            print(f"catalog_expansion: inserted {inserted} artists so far")

    summary = {
        "seeds": len(seeds),
        "new_artists_found": len(new_artists),
        "inserted": inserted,
        "errors": errors,
    }
    if last_error:
        summary["last_error"] = last_error

    print(f"catalog_expansion: done — {summary}")
    return summary


def _load_existing_artist_names() -> set[str]:
    """Load all existing artist names (lowercase) for deduplication."""
    names: set[str] = set()
    offset = 0
    page_size = 1000

    while True:
        resp = (
            admin_supabase.table("artists")
            .select("name")
            .range(offset, offset + page_size - 1)
            .execute()
        )
        rows = resp.data or []
        for row in rows:
            name = (row.get("name") or "").strip().lower()
            if name:
                names.add(name)
        if len(rows) < page_size:
            break
        offset += page_size

    return names


def _load_seed_artists() -> list[dict]:
    """Load artists to use as expansion seeds."""
    all_artists: list[dict] = []
    offset = 0
    page_size = 1000

    while True:
        resp = (
            admin_supabase.table("artists")
            .select("id,name")
            .not_.is_("name", "null")
            .range(offset, offset + page_size - 1)
            .execute()
        )
        rows = resp.data or []
        all_artists.extend(rows)
        if len(rows) < page_size:
            break
        offset += page_size

    return all_artists


def _fetch_similar_artists(client: httpx.Client, name: str) -> list[dict]:
    """Fetch similar artists from Last.fm, including their tags."""
    resp = client.get(
        "https://ws.audioscrobbler.com/2.0/",
        params={
            "method": "artist.getSimilar",
            "artist": name,
            "api_key": settings.lastfm_api_key,
            "format": "json",
            "limit": SIMILAR_PER_ARTIST,
        },
    )
    if resp.status_code != 200:
        return []

    data = resp.json()
    if "error" in data:
        return []

    similar_artists = data.get("similarartists", {}).get("artist") or []
    results = []

    for artist in similar_artists:
        artist_name = (artist.get("name") or "").strip()
        if not artist_name:
            continue

        # Also try to get tags inline (Last.fm sometimes includes them)
        tags = []
        tag_data = artist.get("tags", {})
        if isinstance(tag_data, dict):
            tags = [t.get("name", "") for t in (tag_data.get("tag") or []) if t.get("name")]

        results.append({
            "name": artist_name,
            "tags": tags,
        })

    return results
