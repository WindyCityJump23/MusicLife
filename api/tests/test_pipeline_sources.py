"""Unit tests for the Deezer chart ingestion and track-tag deepening."""

import httpx
import pytest

import app.services.deezer_charts as deezer_charts
from app.services.deezer_charts import MAX_NEW_CHART_ARTISTS, ingest_deezer_chart
from app.services.track_embeddings import _build_embedding_source
from app.services.track_tags_backfill import _fetch_track_tags


class _FakeResponse:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("boom", request=None, response=None)


class _FakeClient:
    def __init__(self, payload):
        self.payload = payload
        self.requests = []

    def get(self, url, params=None, headers=None):
        self.requests.append((url, params))
        return _FakeResponse(self.payload)


def _chart_entry(i: int, artist: str, title: str | None = None):
    return {
        "title": title or f"Hit {i}",
        "link": f"https://www.deezer.com/track/{i}",
        "position": i,
        "artist": {"name": artist},
    }


SOURCE = {"id": 99, "name": "Deezer Charts", "kind": "deezer_chart",
          "url": "https://api.deezer.com/chart/0/tracks", "trust_weight": 0.9}


class TestDeezerChartIngest:
    def test_known_artists_resolve_from_index(self, monkeypatch):
        monkeypatch.setattr(deezer_charts, "_create_chart_artist", lambda name: None)
        client = _FakeClient({"data": [_chart_entry(1, "Dua Lipa")]})
        index = {"dua lipa": 42}
        mentions, created, new_ids = ingest_deezer_chart(client, SOURCE, index)
        assert created == 0 and new_ids == set()
        assert len(mentions) == 1
        m = mentions[0]
        assert m["artist_id"] == 42
        assert m["source_id"] == 99
        assert m["url"] == "https://www.deezer.com/track/1"
        assert "charting at #1" in m["excerpt"]
        assert m["published_at"]  # embedded + recency signal

    def test_unknown_artists_created_and_reported(self, monkeypatch):
        counter = {"next": 100}

        def fake_create(name):
            counter["next"] += 1
            return counter["next"]

        monkeypatch.setattr(deezer_charts, "_create_chart_artist", fake_create)
        client = _FakeClient({"data": [_chart_entry(1, "Brand New Act"), _chart_entry(2, "Brand New Act", "Second Hit")]})
        index: dict[str, int] = {}
        mentions, created, new_ids = ingest_deezer_chart(client, SOURCE, index)
        # Artist created once, then resolved from the mutated index.
        assert created == 1
        assert len(new_ids) == 1
        assert len(mentions) == 2
        assert index["brand new act"] in new_ids

    def test_new_artist_creation_is_capped(self, monkeypatch):
        counter = {"next": 0}

        def fake_create(name):
            counter["next"] += 1
            return counter["next"]

        monkeypatch.setattr(deezer_charts, "_create_chart_artist", fake_create)
        entries = [_chart_entry(i, f"Unknown {i}") for i in range(MAX_NEW_CHART_ARTISTS + 20)]
        client = _FakeClient({"data": entries})
        mentions, created, new_ids = ingest_deezer_chart(client, SOURCE, {})
        assert created == MAX_NEW_CHART_ARTISTS
        assert len(new_ids) == MAX_NEW_CHART_ARTISTS
        assert len(mentions) == MAX_NEW_CHART_ARTISTS  # uncreatable overflow skipped

    def test_malformed_entries_skipped(self, monkeypatch):
        monkeypatch.setattr(deezer_charts, "_create_chart_artist", lambda name: 1)
        client = _FakeClient({"data": [
            {"title": "", "link": "x", "artist": {"name": "A"}},
            {"title": "Song", "link": "", "artist": {"name": "A"}},
            {"title": "Song", "link": "https://d/1", "artist": {}},
            _chart_entry(9, "Real Artist"),
        ]})
        mentions, _, _ = ingest_deezer_chart(client, SOURCE, {"real artist": 7})
        assert len(mentions) == 1
        assert mentions[0]["artist_id"] == 7

    def test_duplicate_links_deduped(self, monkeypatch):
        monkeypatch.setattr(deezer_charts, "_create_chart_artist", lambda name: 1)
        entry = _chart_entry(5, "Same Artist")
        client = _FakeClient({"data": [entry, dict(entry)]})
        mentions, _, _ = ingest_deezer_chart(client, SOURCE, {"same artist": 5})
        assert len(mentions) == 1


class TestTrackTags:
    def test_fetch_filters_junk_and_caps(self):
        payload = {
            "toptags": {"tag": [
                {"name": "Dream Pop"}, {"name": "seen live"}, {"name": "ethereal"},
                *[{"name": f"tag{i}"} for i in range(12)],
            ]}
        }
        client = _FakeClient(payload)
        tags = _fetch_track_tags(client, "Beach House", "Space Song")
        assert "dream pop" in tags
        assert "seen live" not in tags
        assert len(tags) <= 8

    def test_fetch_handles_error_payload(self):
        client = _FakeClient({"error": 6, "message": "Track not found"})
        assert _fetch_track_tags(client, "X", "Y") == []

    def test_embedding_source_includes_tags(self):
        text = _build_embedding_source(
            artist_name="Beach House",
            track_name="Space Song",
            album_name="Depression Cherry",
            tags=["dream pop", "ethereal"],
        )
        assert text == "Beach House – Space Song – Depression Cherry – dream pop, ethereal"

    def test_embedding_source_unchanged_without_tags(self):
        text = _build_embedding_source(
            artist_name="Beach House",
            track_name="Space Song",
            album_name="Depression Cherry",
        )
        assert text == "Beach House – Space Song – Depression Cherry"
