"""Deezer global chart ingestion — a "current hits" editorial source.

Spotify's API no longer exposes popularity or charts, so the Deezer global
top tracks (free, unauthenticated) stand in as the freshest recognizability
signal available. Chart entries flow through the existing mention machinery
(same shape `_extract_mentions` produces, embedded and deduped by
source_ingest._embed_and_upsert on (source_id, url, artist_id)), and
charting artists missing from the catalog are created so the enrichment
finalization pass gives them genres, embeddings, and Last.fm listener stats.
"""

from __future__ import annotations

from datetime import datetime, timezone

import httpx

from app.services.supabase_client import admin_supabase, retry_on_disconnect

# Bound the widening per run: new charting artists trigger enrichment +
# embedding follow-ups, so cap how many the chart can add in one refresh.
MAX_NEW_CHART_ARTISTS = 25
CHART_LIMIT = 100


def ingest_deezer_chart(
    client: httpx.Client,
    source: dict,
    artist_index: dict[str, int],
) -> tuple[list[dict], int, set[int]]:
    """Fetch the chart and return (mention_candidates, new_artists, new_ids).

    ``artist_index`` (lowercased name -> artist id) is mutated as new artists
    are created so repeat chart entries within the run resolve immediately.
    """
    url = str(source.get("url") or "https://api.deezer.com/chart/0/tracks")
    resp = client.get(url, params={"limit": CHART_LIMIT})
    resp.raise_for_status()
    entries = (resp.json() or {}).get("data") or []

    now_iso = datetime.now(timezone.utc).isoformat()
    mentions: list[dict] = []
    new_artist_ids: set[int] = set()
    created = 0
    seen_tracks: set[str] = set()

    for entry in entries:
        title = str(entry.get("title") or "").strip()
        artist_name = str((entry.get("artist") or {}).get("name") or "").strip()
        link = str(entry.get("link") or "").strip()
        position = entry.get("position") or entry.get("rank")
        if not title or not artist_name or not link or link in seen_tracks:
            continue
        seen_tracks.add(link)

        artist_id = artist_index.get(artist_name.lower())
        if artist_id is None:
            if created >= MAX_NEW_CHART_ARTISTS:
                continue
            artist_id = _create_chart_artist(artist_name)
            if artist_id is None:
                continue
            artist_index[artist_name.lower()] = artist_id
            new_artist_ids.add(artist_id)
            created += 1

        position_text = f"#{int(position)}" if isinstance(position, (int, float)) else "the top 100"
        mentions.append(
            {
                "source_id": source["id"],
                "artist_id": artist_id,
                "artist_name_raw": artist_name,
                "title": f"{artist_name} — {title}",
                "url": link,
                # The excerpt is what gets embedded for context matching;
                # keep it descriptive of *current* mainstream momentum.
                "excerpt": (
                    f'"{title}" by {artist_name} is charting at {position_text} '
                    f"on the Deezer global top tracks chart — a current mainstream hit."
                ),
                "published_at": now_iso,
            }
        )

    print(
        f"deezer_charts: {len(entries)} chart entries -> {len(mentions)} mentions, "
        f"{created} new artists"
    )
    return mentions, created, new_artist_ids


def _create_chart_artist(name: str) -> int | None:
    """Create a bare artist row for an unknown charting artist.

    Enrichment (MusicBrainz + Last.fm, including listener stats) and
    embedding happen in the source-ingest finalization pass, which receives
    these ids via the run summary.
    """
    try:
        result = retry_on_disconnect(
            lambda: admin_supabase.table("artists")
            .upsert({"name": name}, on_conflict="name", ignore_duplicates=False)
            .execute()
        )
        rows = result.data or []
        if rows and rows[0].get("id") is not None:
            return int(rows[0]["id"])
        # Upsert returned nothing (e.g. name conflict resolved elsewhere) —
        # fall back to a lookup.
        lookup = retry_on_disconnect(
            lambda: admin_supabase.table("artists")
            .select("id")
            .ilike("name", name)
            .limit(1)
            .execute()
        )
        lookup_rows = lookup.data or []
        return int(lookup_rows[0]["id"]) if lookup_rows else None
    except Exception as exc:
        print(f"deezer_charts: could not create artist {name!r}: {exc}")
        return None
