"""
Artist enrichment service.

For each artist in public.artists where musicbrainz_id and lastfm_url are both null:
  1. Fetch MusicBrainz MBID — hard 1 req/s rate limit; sleep 1.1s between calls.
  2. Fetch Last.fm metadata (bio, tags, similar artists).
  3. Build embedding_source: "bio | tag1, tag2 | similar1, similar2" (≤2000 chars).
  4. Update the artist row with all available fields.

Runs capped at 200 candidates per invocation to keep wall time bounded.
Uses admin_supabase (service role) to bypass RLS — this is a trusted backend job.
"""

from __future__ import annotations

import re
import time
import urllib.parse

import httpx

from app.config import settings
from app.services.supabase_client import admin_supabase


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def run_artist_enrichment() -> None:
    result = (
        admin_supabase.table("artists")
        .select("id, name, spotify_artist_id")
        .is_("musicbrainz_id", "null")
        .is_("lastfm_url", "null")
        .limit(200)
        .execute()
    )

    candidates = result.data or []
    if not candidates:
        print("artist_enrichment: no candidates found")
        return

    print(f"artist_enrichment: enriching {len(candidates)} artists")

    with httpx.Client(timeout=10) as client:
        for i, artist in enumerate(candidates):
            if i > 0:
                time.sleep(1.1)  # MusicBrainz hard rate limit: 1 req/s
            try:
                _enrich_one(client, artist)
            except Exception as exc:
                print(f"artist_enrichment: failed for {artist['name']!r}: {exc}")

    print("artist_enrichment: done")


# ---------------------------------------------------------------------------
# Per-artist logic
# ---------------------------------------------------------------------------


def _enrich_one(client: httpx.Client, artist: dict) -> None:
    name = artist["name"]
    artist_id = artist["id"]

    update: dict = {}

    try:
        mbid = _fetch_musicbrainz(client, name)
        if mbid:
            update["musicbrainz_id"] = mbid
    except Exception as exc:
        print(f"artist_enrichment: MusicBrainz failed for {name!r}: {exc}")

    try:
        lastfm = _fetch_lastfm(client, name)
        if lastfm:
            if lastfm.get("url"):
                update["lastfm_url"] = lastfm["url"]
            embedding_source = _build_embedding_source(
                bio=lastfm.get("bio", ""),
                tags=lastfm.get("tags", []),
                similar=lastfm.get("similar", []),
            )
            if embedding_source:
                update["embedding_source"] = embedding_source
    except Exception as exc:
        print(f"artist_enrichment: Last.fm failed for {name!r}: {exc}")

    if update:
        admin_supabase.table("artists").update(update).eq("id", artist_id).execute()
        print(f"artist_enrichment: updated {name!r} — fields: {list(update.keys())}")
    else:
        print(f"artist_enrichment: no data found for {name!r}")


# ---------------------------------------------------------------------------
# External API fetchers
# ---------------------------------------------------------------------------


def _fetch_musicbrainz(client: httpx.Client, name: str) -> str | None:
    resp = client.get(
        "https://musicbrainz.org/ws/2/artist/",
        params={"query": name, "fmt": "json", "limit": 1},
        headers={"User-Agent": settings.musicbrainz_user_agent},
    )
    resp.raise_for_status()
    artists = resp.json().get("artists", [])
    if not artists:
        return None
    return artists[0].get("id")  # MBID


def _fetch_lastfm(client: httpx.Client, name: str) -> dict | None:
    resp = client.get(
        "https://ws.audioscrobbler.com/2.0/",
        params={
            "method": "artist.getInfo",
            "artist": name,
            "api_key": settings.lastfm_api_key,
            "format": "json",
        },
    )
    resp.raise_for_status()
    data = resp.json()
    if "error" in data:
        return None

    artist = data.get("artist", {})
    bio = _strip_html(artist.get("bio", {}).get("summary", ""))
    tags = [t["name"] for t in (artist.get("tags", {}).get("tag") or [])]
    similar = [s["name"] for s in (artist.get("similar", {}).get("artist") or [])]
    url = artist.get("url", "")

    return {"bio": bio, "tags": tags, "similar": similar, "url": url}


# ---------------------------------------------------------------------------
# Text helpers
# ---------------------------------------------------------------------------


def _strip_html(text: str) -> str:
    return re.sub(r"<[^>]+>", "", text).strip()


def _build_embedding_source(bio: str, tags: list[str], similar: list[str]) -> str:
    parts = [p for p in [bio, ", ".join(tags), ", ".join(similar)] if p]
    return " | ".join(parts)[:2000]
