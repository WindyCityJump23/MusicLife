"""
Spotify ingestion service.

Execution plan:
  1) GET /me/tracks (saved tracks; paginate with limit/offset)
  2) GET /me/top/artists for short_term, medium_term, long_term
  3) GET /me/player/recently-played
  4) Normalize artist + track entities and upsert into Supabase tables
  5) Upsert user_tracks and insert listen_events

This module currently captures the orchestration contract used by routes/ingest.py.
"""

from __future__ import annotations

import httpx


def run_spotify_library_ingest(user_id: str, access_token: str) -> None:
    """Fetches Spotify library signals.

    TODO: persist payloads into Supabase once DB schema migration is applied.
    """
    headers = {"Authorization": f"Bearer {access_token}"}

    with httpx.Client(timeout=30) as client:
        _fetch_saved_tracks(client, headers)
        for term in ("short_term", "medium_term", "long_term"):
            _fetch_top_artists(client, headers, term)
        _fetch_recently_played(client, headers)

    _ = user_id


def _fetch_saved_tracks(client: httpx.Client, headers: dict[str, str]) -> None:
    offset = 0
    while True:
        resp = client.get(
            "https://api.spotify.com/v1/me/tracks",
            headers=headers,
            params={"limit": 50, "offset": offset},
        )
        resp.raise_for_status()
        payload = resp.json()
        items = payload.get("items", [])
        if not items:
            return
        offset += len(items)


def _fetch_top_artists(client: httpx.Client, headers: dict[str, str], term: str) -> None:
    resp = client.get(
        "https://api.spotify.com/v1/me/top/artists",
        headers=headers,
        params={"time_range": term, "limit": 50},
    )
    resp.raise_for_status()


def _fetch_recently_played(client: httpx.Client, headers: dict[str, str]) -> None:
    resp = client.get(
        "https://api.spotify.com/v1/me/player/recently-played",
        headers=headers,
        params={"limit": 50},
    )
    resp.raise_for_status()
