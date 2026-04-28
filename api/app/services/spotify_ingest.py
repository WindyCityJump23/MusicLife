"""
Spotify ingestion service.

Execution order:
  1) GET /me/tracks          — saved tracks, paginated
  2) GET /me/top/artists     — short/medium/long_term; carry genres + popularity
  3) GET /me/player/recently-played
  4) Upsert artists from all three sources into public.artists
  5) Upsert tracks into public.tracks
  6) Upsert public.user_tracks (added_at from saved; play_count + last_played_at from recent)
  7) Insert public.listen_events from recently-played, skipping duplicates

Uses admin_supabase (service role) throughout — ingestion is a trusted backend job
that must bypass RLS to write catalog rows (artists, tracks) on behalf of the user.
"""

from __future__ import annotations

from collections import defaultdict

import httpx

from app.services.supabase_client import admin_supabase


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def run_spotify_library_ingest(user_id: str, access_token: str) -> None:
    headers = {"Authorization": f"Bearer {access_token}"}

    with httpx.Client(timeout=30) as client:
        saved_items = _fetch_saved_tracks(client, headers)
        top_artists: list[dict] = []
        for term in ("short_term", "medium_term", "long_term"):
            top_artists.extend(_fetch_top_artists(client, headers, term))
        recent_items = _fetch_recently_played(client, headers)
        # Will fetch audio features after tracks are upserted
        _client_ref = client
        _headers_ref = headers

    # Build a deduped artist map keyed by Spotify artist ID.
    # Top-artist objects carry genres + popularity; prefer them over the
    # simplified stubs that appear inside track.artists on other endpoints.
    artist_objs: dict[str, dict] = {}
    for item in saved_items:
        for a in item["track"].get("artists", []):
            if a.get("id") and a["id"] not in artist_objs:
                artist_objs[a["id"]] = a
    for a in top_artists:
        if a.get("id"):
            artist_objs[a["id"]] = a  # overwrite stubs with richer data
    for item in recent_items:
        for a in item["track"].get("artists", []):
            if a.get("id") and a["id"] not in artist_objs:
                artist_objs[a["id"]] = a

    artist_id_map = _upsert_artists(list(artist_objs.values()))

    # Dedup tracks across saved + recently-played.
    track_objs: dict[str, dict] = {}
    for item in saved_items:
        t = item["track"]
        if t.get("id"):
            track_objs[t["id"]] = t
    for item in recent_items:
        t = item["track"]
        if t.get("id") and t["id"] not in track_objs:
            track_objs[t["id"]] = t

    track_id_map = _upsert_tracks(list(track_objs.values()), artist_id_map)

    # Fetch and store audio features for all tracks
    _fetch_and_store_audio_features(_client_ref, _headers_ref, list(track_objs.keys()))

    # Saved tracks establish added_at; run before recent so the play_count
    # written by _upsert_user_tracks_recent always takes precedence.
    _upsert_user_tracks_saved(user_id, saved_items, track_id_map)
    _upsert_user_tracks_recent(user_id, recent_items, track_id_map)
    _insert_listen_events(user_id, recent_items, track_id_map)


# ---------------------------------------------------------------------------
# Persistence helpers
# ---------------------------------------------------------------------------


def _upsert_artists(artists: list[dict]) -> dict[str, int]:
    """Upsert artist rows; return {spotify_artist_id: db_id}."""
    if not artists:
        return {}
    rows = [
        {
            "spotify_artist_id": a["id"],
            "name": a["name"],
            "genres": a.get("genres", []),
            "popularity": a.get("popularity"),
        }
        for a in artists
    ]
    admin_supabase.table("artists").upsert(
        rows, on_conflict="spotify_artist_id"
    ).execute()
    # SELECT after upsert: PostgREST may return empty data for rows resolved
    # via ON CONFLICT DO UPDATE, so we can't rely on the upsert response alone.
    spotify_ids = [r["spotify_artist_id"] for r in rows]
    result = (
        admin_supabase.table("artists")
        .select("id, spotify_artist_id")
        .in_("spotify_artist_id", spotify_ids)
        .execute()
    )
    return {row["spotify_artist_id"]: row["id"] for row in (result.data or [])}


def _upsert_tracks(tracks: list[dict], artist_id_map: dict[str, int]) -> dict[str, int]:
    """Upsert track rows; return {spotify_track_id: db_id}."""
    if not tracks:
        return {}
    rows = []
    for t in tracks:
        primary_artist_id = ((t.get("artists") or [{}])[0]).get("id")
        rows.append(
            {
                "spotify_track_id": t["id"],
                "artist_id": artist_id_map.get(primary_artist_id),
                "name": t["name"],
                "album_name": (t.get("album") or {}).get("name"),
                "duration_ms": t.get("duration_ms"),
                "explicit": t.get("explicit"),
                "popularity": t.get("popularity"),
            }
        )
    admin_supabase.table("tracks").upsert(
        rows, on_conflict="spotify_track_id"
    ).execute()
    # SELECT after upsert for the same reason as _upsert_artists.
    spotify_ids = [r["spotify_track_id"] for r in rows]
    result = (
        admin_supabase.table("tracks")
        .select("id, spotify_track_id")
        .in_("spotify_track_id", spotify_ids)
        .execute()
    )
    return {row["spotify_track_id"]: row["id"] for row in (result.data or [])}


def _upsert_user_tracks_saved(
    user_id: str,
    saved_items: list[dict],
    track_id_map: dict[str, int],
) -> None:
    """Upsert user_tracks rows from the saved-tracks library.

    Explicitly includes play_count=0 so new rows satisfy the NOT NULL constraint.
    A subsequent call to _upsert_user_tracks_recent will overwrite play_count for
    any track that also appears in the recently-played window.
    """
    rows = []
    for item in saved_items:
        db_id = track_id_map.get(item["track"].get("id"))
        if not db_id:
            continue
        rows.append(
            {
                "user_id": user_id,
                "track_id": db_id,
                "added_at": item.get("added_at"),
                "play_count": 0,
            }
        )
    if rows:
        admin_supabase.table("user_tracks").upsert(
            rows, on_conflict="user_id,track_id"
        ).execute()


def _upsert_user_tracks_recent(
    user_id: str,
    recent_items: list[dict],
    track_id_map: dict[str, int],
) -> None:
    """Update user_tracks with play_count and last_played_at from recently-played.

    play_count reflects the count within the 50-play window returned by Spotify,
    not the lifetime total. Accurate lifetime counts require a separate aggregation
    over the listen_events table.
    """
    play_counts: dict[int, int] = defaultdict(int)
    last_played: dict[int, str] = {}
    for item in recent_items:
        db_id = track_id_map.get(item["track"].get("id"))
        if not db_id:
            continue
        play_counts[db_id] += 1
        played_at = item.get("played_at", "")
        if played_at > last_played.get(db_id, ""):
            last_played[db_id] = played_at

    rows = [
        {
            "user_id": user_id,
            "track_id": db_id,
            "play_count": count,
            "last_played_at": last_played[db_id],
        }
        for db_id, count in play_counts.items()
    ]
    if rows:
        admin_supabase.table("user_tracks").upsert(
            rows, on_conflict="user_id,track_id"
        ).execute()


def _insert_listen_events(
    user_id: str,
    recent_items: list[dict],
    track_id_map: dict[str, int],
) -> None:
    """Insert listen_events from recently-played, skipping already-ingested rows.

    Relies on the unique constraint added in migration 004:
      UNIQUE (user_id, track_id, listened_at)
    """
    rows = []
    for item in recent_items:
        db_id = track_id_map.get(item["track"].get("id"))
        if not db_id or not item.get("played_at"):
            continue
        rows.append(
            {
                "user_id": user_id,
                "track_id": db_id,
                "listened_at": item["played_at"],
                "source": "spotify_recent",
            }
        )
    if rows:
        try:
            admin_supabase.table("listen_events").upsert(
                rows,
                on_conflict="user_id,track_id,listened_at",
                ignore_duplicates=True,
            ).execute()
        except Exception as e:
            if "42P10" in str(e):
                # Constraint missing — fall back to row-by-row insert
                print("spotify_ingest: listen_events_dedup_key missing, inserting row-by-row")
                for row in rows:
                    try:
                        admin_supabase.table("listen_events").insert(row).execute()
                    except Exception:
                        pass  # duplicate or transient error
            else:
                raise


# ---------------------------------------------------------------------------
# Spotify API fetch helpers
# ---------------------------------------------------------------------------


def _fetch_saved_tracks(client: httpx.Client, headers: dict[str, str]) -> list[dict]:
    items: list[dict] = []
    offset = 0
    while True:
        resp = client.get(
            "https://api.spotify.com/v1/me/tracks",
            headers=headers,
            params={"limit": 50, "offset": offset},
        )
        resp.raise_for_status()
        batch = resp.json().get("items", [])
        if not batch:
            break
        items.extend(batch)
        offset += len(batch)
    return items


def _fetch_top_artists(
    client: httpx.Client, headers: dict[str, str], term: str
) -> list[dict]:
    resp = client.get(
        "https://api.spotify.com/v1/me/top/artists",
        headers=headers,
        params={"time_range": term, "limit": 50},
    )
    resp.raise_for_status()
    return resp.json().get("items", [])


def _fetch_recently_played(
    client: httpx.Client, headers: dict[str, str]
) -> list[dict]:
    resp = client.get(
        "https://api.spotify.com/v1/me/player/recently-played",
        headers=headers,
        params={"limit": 50},
    )
    resp.raise_for_status()
    return resp.json().get("items", [])


def _fetch_and_store_audio_features(
    client: httpx.Client, headers: dict[str, str], spotify_track_ids: list[str]
) -> None:
    """Fetch Spotify audio features for tracks and store them in the DB.

    The Spotify audio-features endpoint accepts up to 100 track IDs at once.
    We only fetch features for tracks that don't already have them stored.
    """
    if not spotify_track_ids:
        return

    # Check which tracks already have audio features
    existing_resp = (
        admin_supabase.table("tracks")
        .select("spotify_track_id")
        .in_("spotify_track_id", spotify_track_ids)
        .not_.is_("energy", "null")
        .execute()
    )
    already_have = {
        row["spotify_track_id"] for row in (existing_resp.data or [])
    }
    need_features = [tid for tid in spotify_track_ids if tid not in already_have]

    if not need_features:
        print(f"spotify_ingest: all {len(spotify_track_ids)} tracks already have audio features")
        return

    print(f"spotify_ingest: fetching audio features for {len(need_features)} tracks")

    # Process in batches of 100 (Spotify API limit)
    for i in range(0, len(need_features), 100):
        batch = need_features[i : i + 100]
        ids_param = ",".join(batch)

        try:
            resp = client.get(
                "https://api.spotify.com/v1/audio-features",
                headers=headers,
                params={"ids": ids_param},
            )
            resp.raise_for_status()
            features_list = resp.json().get("audio_features", [])
        except Exception as exc:
            print(f"spotify_ingest: audio features fetch failed for batch {i // 100 + 1}: {exc}")
            continue

        updates = []
        for feat in features_list:
            if not feat or not feat.get("id"):
                continue
            updates.append({
                "spotify_track_id": feat["id"],
                "energy": feat.get("energy"),
                "danceability": feat.get("danceability"),
                "valence": feat.get("valence"),
                "tempo": feat.get("tempo"),
                "acousticness": feat.get("acousticness"),
                "instrumentalness": feat.get("instrumentalness"),
                "speechiness": feat.get("speechiness"),
                "loudness": feat.get("loudness"),
                "mode": feat.get("mode"),
                "key": feat.get("key"),
            })

        if updates:
            try:
                admin_supabase.table("tracks").upsert(
                    updates, on_conflict="spotify_track_id"
                ).execute()
                print(f"spotify_ingest: wrote audio features for {len(updates)} tracks (batch {i // 100 + 1})")
            except Exception as exc:
                print(f"spotify_ingest: audio features DB write failed: {exc}")

    print("spotify_ingest: audio features sync complete")
