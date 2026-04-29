"""
Artist enrichment service.

For each artist in public.artists where musicbrainz_id and lastfm_url are both null:
  1. Fetch MusicBrainz MBID — hard 1 req/s rate limit; sleep 1.1s between calls.
  2. Fetch Last.fm metadata (bio, tags, similar artists).
  3. Build embedding_source: "bio | tag1, tag2 | similar1, similar2" (≤2000 chars).
  4. Update the artist row with all available fields.

After enrichment, the Last.fm "similar" names collected across this run are
inserted as new artist rows (name only, no spotify_artist_id). On the next
enrichment + embedding cycle they pick up bio/tags/embeddings of their own,
which expands the Discover candidate pool beyond the user's library.

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

# Catalog-expansion limits. Last.fm artist.getInfo can return up to ~100
# similars per artist; cap to keep growth predictable.
MAX_SIMILAR_PER_ARTIST = 10
# Hard cap on new rows per run so a single enrichment can't balloon the
# catalog. The next run picks up where this one left off.
MAX_NEW_ARTISTS_PER_RUN = 500


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

    discovered_names: list[str] = []

    with httpx.Client(timeout=10) as client:
        for i, artist in enumerate(candidates):
            if i > 0:
                time.sleep(1.1)  # MusicBrainz hard rate limit: 1 req/s
            try:
                similars = _enrich_one(client, artist)
                if similars:
                    discovered_names.extend(similars[:MAX_SIMILAR_PER_ARTIST])
            except Exception as exc:
                print(f"artist_enrichment: failed for {artist['name']!r}: {exc}")

    if discovered_names:
        try:
            added = _insert_discovered_artists(discovered_names)
            if added:
                print(
                    f"artist_enrichment: catalog expanded by {added} new artists "
                    "from Last.fm similars (will be enriched + embedded on next run)"
                )
        except Exception as exc:
            print(f"artist_enrichment: catalog expansion failed: {exc}")

    print("artist_enrichment: done")


# ---------------------------------------------------------------------------
# Per-artist logic
# ---------------------------------------------------------------------------


def _enrich_one(client: httpx.Client, artist: dict) -> list[str]:
    """Enrich a single artist row in place. Returns Last.fm "similar" names
    for catalog-expansion bookkeeping (caller decides whether to insert them).
    """
    name = artist["name"]
    artist_id = artist["id"]

    update: dict = {}
    similars: list[str] = []

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
            similars = lastfm.get("similar") or []
            embedding_source = _build_embedding_source(
                bio=lastfm.get("bio", ""),
                tags=lastfm.get("tags", []),
                similar=similars,
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

    return similars


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


# ---------------------------------------------------------------------------
# Catalog expansion
# ---------------------------------------------------------------------------


def _insert_discovered_artists(names: list[str]) -> int:
    """Insert Last.fm similar-artist names that aren't in the catalog yet.

    These rows have only `name` set — no spotify_artist_id, musicbrainz_id,
    lastfm_url, embedding_source, or embedding. Subsequent enrichment runs
    will pick them up (the candidate filter is `musicbrainz_id is null and
    lastfm_url is null`) and fill in the rest, after which the embedding job
    will give them taste vectors. Once embedded, they become non-library
    Discover candidates.
    """
    seen: set[str] = set()
    unique: list[str] = []
    for raw in names:
        name = (raw or "").strip()
        if not name:
            continue
        low = name.lower()
        if low in seen:
            continue
        seen.add(low)
        unique.append(name)

    if not unique:
        return 0

    # Filter against existing catalog (case-insensitive). The artists table is
    # bounded by what users have ingested — hundreds to low tens of thousands
    # of rows — so loading names into memory is fine.
    existing_resp = admin_supabase.table("artists").select("name").execute()
    existing_lower = {
        (row.get("name") or "").strip().lower()
        for row in (existing_resp.data or [])
        if row.get("name")
    }

    new_rows = [{"name": n} for n in unique if n.lower() not in existing_lower]
    new_rows = new_rows[:MAX_NEW_ARTISTS_PER_RUN]
    if not new_rows:
        return 0

    admin_supabase.table("artists").insert(new_rows).execute()
    return len(new_rows)
