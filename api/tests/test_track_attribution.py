"""Tests for track→artist attribution at ingest.

Regression cover for the bug that filed other artists' music under an artist
the listener actually matched: religious and devotional tracks (a Quran
recitation, worship songs off JESUS IS KING), opera, and children's music all
reached a dance/electronic listener's station because they were stored with
the wrong artist_id.

Two ingest paths produced it, and both are covered here:
  * the albums walk kept every track on an album the artist was credited on;
  * the search top-up used the fuzzy `artist:"Name"` filter and padded small
    catalogs up to the 50-track quota with whoever else matched the string.
"""

import httpx
import pytest

from app.services.track_populator import (
    _search_and_upsert_tracks,
    track_credits_artist,
)


def _track(tid: str, name: str, artists: list[dict], album: str = "Album") -> dict:
    return {
        "id": tid,
        "name": name,
        "artists": artists,
        "album": {"name": album, "release_date": "2020-01-01"},
        "duration_ms": 200_000,
        "explicit": False,
        "popularity": 50,
    }


class TestTrackCreditsArtist:
    def test_accepts_track_credited_by_spotify_id(self):
        track = _track("t1", "Real Song", [{"id": "ARTIST_A", "name": "Artist A"}])
        assert track_credits_artist(track, "ARTIST_A", "Artist A") is True

    def test_accepts_when_artist_is_a_featured_credit(self):
        track = _track(
            "t1", "Collab",
            [{"id": "ARTIST_B", "name": "Artist B"}, {"id": "ARTIST_A", "name": "Artist A"}],
        )
        assert track_credits_artist(track, "ARTIST_A", "Artist A") is True

    def test_rejects_other_artists_track(self):
        # The real case: a Quran recitation returned by artist:"Qari".
        track = _track(
            "t1", "Ayatul Kursi",
            [{"id": "SOMEONE_ELSE", "name": "Mishary Rashid Alafasy"}],
            album="THE HOLY QURAN",
        )
        assert track_credits_artist(track, "QARI_ID", "Qari") is False

    def test_rejects_similar_name_different_artist(self):
        # artist:"Bryn Christopher" returning Bryn Terfel opera.
        track = _track(
            "t1", "Toreador Song",
            [{"id": "TERFEL", "name": "Bryn Terfel"}],
            album="Bryn Terfel sings Favourites",
        )
        assert track_credits_artist(track, "BRYN_C", "Bryn Christopher") is False

    def test_id_match_wins_over_name_when_id_is_known(self):
        # Same display name, different artist — the ID is the authority.
        track = _track("t1", "Song", [{"id": "OTHER", "name": "Artist A"}])
        assert track_credits_artist(track, "ARTIST_A", "Artist A") is False

    def test_falls_back_to_name_when_no_spotify_id_stored(self):
        track = _track("t1", "Song", [{"id": "X", "name": "The Wombats"}])
        assert track_credits_artist(track, "", "the wombats") is True
        assert track_credits_artist(track, "", "The  Wombats!") is True
        assert track_credits_artist(track, "", "Wombat") is False

    def test_missing_credits_are_not_claimed(self):
        # No evidence is not evidence of ownership.
        assert track_credits_artist({"id": "t1"}, "ARTIST_A", "Artist A") is False
        assert track_credits_artist({"id": "t1", "artists": []}, "A", "Artist A") is False


class _FakeResponse:
    def __init__(self, payload: dict, status_code: int = 200) -> None:
        self._payload = payload
        self.status_code = status_code
        self.headers: dict[str, str] = {}
        self.text = ""

    def json(self) -> dict:
        return self._payload


class _FakeSpotify:
    """Stands in for httpx.Client against the endpoints the populator uses."""

    def __init__(self, albums: list[dict], album_tracks: dict, search: list[dict]) -> None:
        self.albums = albums
        self.album_tracks = album_tracks
        self.search = search

    def request(self, _method: str, url: str, params=None, headers=None):
        params = params or {}
        if "/albums" in url and "/artists/" in url:
            return _FakeResponse({"items": self.albums})
        if url.startswith("https://api.spotify.com/v1/albums/"):
            album_id = url.split("/albums/")[1].split("/")[0]
            return _FakeResponse({"items": self.album_tracks.get(album_id, [])})
        if url.endswith("/v1/search"):
            offset = int(params.get("offset") or 0)
            limit = int(params.get("limit") or 10)
            return _FakeResponse({"tracks": {"items": self.search[offset : offset + limit]}})
        if url.endswith("/v1/tracks"):
            ids = (params.get("ids") or "").split(",")
            return _FakeResponse({"tracks": [{"id": i, "popularity": 42} for i in ids]})
        return _FakeResponse({}, status_code=404)


@pytest.fixture
def captured_rows(monkeypatch):
    """Capture what the populator would upsert instead of hitting Supabase."""
    rows: list[dict] = []

    def _fake_retry(fn, attempts=3):
        return fn()

    class _Table:
        def upsert(self, payload, on_conflict=None):
            rows.extend(payload)
            return self

        def execute(self):
            class _R:
                data = []
            return _R()

    class _Admin:
        def table(self, _name):
            return _Table()

    monkeypatch.setattr("app.services.track_populator.admin_supabase", _Admin())
    monkeypatch.setattr("app.services.track_populator.retry_on_disconnect", _fake_retry)
    return rows


class TestIngestAttribution:
    def test_album_walk_drops_other_artists_tracks(self, captured_rows):
        # A compilation the artist appears on once. Every other track belongs
        # to someone else and must not be filed under them.
        albums = [{"id": "alb1", "name": "JESUS IS KING", "release_date": "2019-10-25"}]
        album_tracks = {
            "alb1": [
                _track("k1", "Everything We Need", [{"id": "KANYE", "name": "Kanye West"}]),
                _track("k2", "Water", [{"id": "KANYE", "name": "Kanye West"}]),
                _track("k3", "Guest Spot", [
                    {"id": "KANYE", "name": "Kanye West"},
                    {"id": "ANT", "name": "Ant Clemons"},
                ]),
            ]
        }
        fake = _FakeSpotify(albums, album_tracks, search=[])
        added, err = _search_and_upsert_tracks(
            fake, {}, {"id": 51144, "name": "Ant Clemons", "spotify_artist_id": "ANT"}, 50
        )
        assert err is None
        names = [r["name"] for r in captured_rows]
        assert names == ["Guest Spot"], f"expected only the credited track, got {names}"
        assert added == 1

    def test_search_topup_drops_fuzzy_name_matches(self, captured_rows):
        # artist:"amanda williams" returning Vaughan Williams and a worship
        # album -- the shape actually observed in production.
        search = [
            _track("s1", "Simply Jesus - Acoustic", [{"id": "OTHER1", "name": "Chris Tomlin"}], "Abide (Deluxe)"),
            _track("s2", "Serenade to Music", [{"id": "OTHER2", "name": "Vaughan Williams"}], "A Sea Symphony"),
            _track("s3", "Her Own Song", [{"id": "AMANDA", "name": "amanda williams"}], "Words"),
        ]
        fake = _FakeSpotify(albums=[], album_tracks={}, search=search)
        added, err = _search_and_upsert_tracks(
            fake, {}, {"id": 56742, "name": "amanda williams", "spotify_artist_id": "AMANDA"}, 50
        )
        assert err is None
        names = [r["name"] for r in captured_rows]
        assert names == ["Her Own Song"], f"expected only the credited track, got {names}"
        assert added == 1

    def test_small_catalog_is_not_padded_to_the_quota(self, captured_rows):
        # The quota is what forced the junk in: an artist with 2 songs used to
        # be topped up to 50 with other people's music.
        albums = [{"id": "alb1", "name": "EP", "release_date": "2021-01-01"}]
        album_tracks = {
            "alb1": [
                _track("a1", "One", [{"id": "SMALL", "name": "Small Artist"}]),
                _track("a2", "Two", [{"id": "SMALL", "name": "Small Artist"}]),
            ]
        }
        search = [
            _track(f"pad{i}", f"Padding {i}", [{"id": "NOTSMALL", "name": "Someone Else"}])
            for i in range(40)
        ]
        fake = _FakeSpotify(albums, album_tracks, search)
        added, _ = _search_and_upsert_tracks(
            fake, {}, {"id": 1, "name": "Small Artist", "spotify_artist_id": "SMALL"}, 50
        )
        assert added == 2, "a 2-song catalog must stay 2 songs"
        assert {r["name"] for r in captured_rows} == {"One", "Two"}

    def test_genuine_catalog_is_preserved(self, captured_rows):
        albums = [{"id": "alb1", "name": "LP", "release_date": "2021-01-01"}]
        album_tracks = {
            "alb1": [
                _track(f"g{i}", f"Track {i}", [{"id": "REAL", "name": "Real Artist"}])
                for i in range(12)
            ]
        }
        fake = _FakeSpotify(albums, album_tracks, search=[])
        added, _ = _search_and_upsert_tracks(
            fake, {}, {"id": 2, "name": "Real Artist", "spotify_artist_id": "REAL"}, 50
        )
        assert added == 12
        assert all(r["artist_id"] == 2 for r in captured_rows)
