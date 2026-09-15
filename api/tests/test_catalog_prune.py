"""Tests for the catalog prune — the cheap repair path.

The attribution audit costs one Spotify request per track, which a
Development Mode quota cannot absorb across 24k rows. This job asks what an
artist's catalog *is* (≈7 requests per artist) and treats anything stored
under them but absent from it as misattributed.

That inversion is only safe with two guards, both covered here: a truncated
catalog proves nothing, and user_tracks rows cascade on delete.
"""

import pytest

from app.services import catalog_prune as CP
from app.services.track_populator import TRACKS_PER_ARTIST


@pytest.fixture
def db(monkeypatch):
    """In-memory stand-in for the three tables the prune touches."""
    state = {
        "artists": [{"id": 1, "name": "Real Artist", "spotify_artist_id": "SP1"}],
        "tracks": [],
        "user_tracks": [],
        "deleted": [],
    }

    class _Q:
        def __init__(self, table): self.table = table; self.rows = list(state[table]); self._del = False
        def select(self, *a, **k): return self
        def eq(self, f, v): self.rows = [r for r in self.rows if r.get(f) == v]; return self
        def in_(self, f, vals):
            s = set(vals); self.rows = [r for r in self.rows if r.get(f) in s]; return self
        @property
        def not_(self): return self
        def is_(self, f, v): return self
        def range(self, *a): return self
        def delete(self): self._del = True; return self
        def execute(self):
            if self._del:
                ids = {r["id"] for r in self.rows}
                state["deleted"].extend(sorted(ids))
                state["tracks"][:] = [t for t in state["tracks"] if t["id"] not in ids]
            class R: pass
            r = R(); r.data = self.rows; return r

    class _Admin:
        def table(self, name): return _Q(name)

    monkeypatch.setattr(CP, "admin_supabase", _Admin())
    monkeypatch.setattr(CP, "retry_on_disconnect", lambda fn, attempts=3: fn())
    monkeypatch.setattr(CP.time, "sleep", lambda *_: None)
    return state


def _stub_fetch(monkeypatch, verified_ids, error=None):
    def fake(client, headers, artist, limit):
        return [{"id": i} for i in verified_ids], error
    monkeypatch.setattr(CP, "fetch_verified_tracks", fake)


def _stub_confirm(monkeypatch, credits_by_stid=None):
    """Per-track confirmation: default says the candidate is genuinely wrong."""
    credits_by_stid = credits_by_stid or {}

    def fake_full(client, headers, ids, **kw):
        return {
            i: {"id": i, "artists": credits_by_stid.get(i, [{"id": "OTHER", "name": "Someone Else"}])}
            for i in ids
        }
    monkeypatch.setattr(CP, "fetch_full_tracks", fake_full)


class TestCatalogPrune:
    def test_flags_tracks_absent_from_the_verified_catalog(self, db, monkeypatch):
        db["tracks"] = [
            {"id": 10, "name": "Real Song", "spotify_track_id": "a", "artist_id": 1},
            {"id": 11, "name": "Someone Else's", "spotify_track_id": "zz", "artist_id": 1},
        ]
        _stub_fetch(monkeypatch, ["a", "b"])
        _stub_confirm(monkeypatch)
        s = CP.run_catalog_prune("tok", apply=False)
        assert s["misattributed"] == 1
        assert s["findings"][0]["track_id"] == 11
        assert s["deleted"] == 0, "report mode must not delete"
        assert db["deleted"] == []

    def test_apply_deletes_only_the_flagged_rows(self, db, monkeypatch):
        db["tracks"] = [
            {"id": 10, "name": "Real Song", "spotify_track_id": "a", "artist_id": 1},
            {"id": 11, "name": "Someone Else's", "spotify_track_id": "zz", "artist_id": 1},
        ]
        _stub_fetch(monkeypatch, ["a"])
        _stub_confirm(monkeypatch)
        s = CP.run_catalog_prune("tok", apply=True)
        assert s["deleted"] == 1
        assert db["deleted"] == [11]
        assert [t["id"] for t in db["tracks"]] == [10]

    def test_truncated_catalog_is_skipped_entirely(self, db, monkeypatch):
        # A full result may be a partial view of a deep catalog, so absence
        # proves nothing and nothing may be deleted.
        db["tracks"] = [{"id": 99, "name": "Deep Cut", "spotify_track_id": "zz", "artist_id": 1}]
        _stub_fetch(monkeypatch, [f"id{i}" for i in range(TRACKS_PER_ARTIST)])
        _stub_confirm(monkeypatch)
        s = CP.run_catalog_prune("tok", apply=True)
        assert s["artists_skipped_truncated"] == 1
        assert s["misattributed"] == 0
        assert db["deleted"] == []

    def test_library_tracks_are_protected_not_deleted(self, db, monkeypatch):
        # user_tracks.track_id is ON DELETE CASCADE.
        db["tracks"] = [{"id": 12, "name": "In Library", "spotify_track_id": "zz", "artist_id": 1}]
        db["user_tracks"] = [{"track_id": 12}]
        _stub_fetch(monkeypatch, ["a"])
        _stub_confirm(monkeypatch)
        s = CP.run_catalog_prune("tok", apply=True)
        assert s["protected_by_library"] == 1
        assert s["misattributed"] == 0
        assert db["deleted"] == []

    def test_request_budget_stops_cleanly(self, db, monkeypatch):
        db["artists"] = [
            {"id": i, "name": f"A{i}", "spotify_artist_id": f"SP{i}"} for i in range(1, 21)
        ]
        _stub_fetch(monkeypatch, ["a"])
        _stub_confirm(monkeypatch)
        s = CP.run_catalog_prune("tok", apply=False, request_budget=20)
        assert s["stopped_early"] is True
        assert s["artists_examined"] < 20, "must stop before sweeping everything"

    def test_auth_failure_is_reported_not_swallowed(self, db, monkeypatch):
        def boom(client, headers, artist, limit):
            raise CP.SpotifyAuthError("Spotify rejected the token (HTTP 401)")
        monkeypatch.setattr(CP, "fetch_verified_tracks", boom)
        s = CP.run_catalog_prune("tok", apply=True)
        assert "error" in s and "401" in s["error"]
        assert s["deleted"] == 0

    def test_tracks_without_a_spotify_id_are_never_flagged(self, db, monkeypatch):
        # Nothing to compare against; absence from the verified set is
        # meaningless for a row that carries no Spotify id.
        db["tracks"] = [{"id": 13, "name": "Manual Row", "spotify_track_id": None, "artist_id": 1}]
        _stub_fetch(monkeypatch, ["a"])
        _stub_confirm(monkeypatch)
        s = CP.run_catalog_prune("tok", apply=True)
        assert s["misattributed"] == 0
        assert db["deleted"] == []


class TestPerTrackConfirmation:
    """The cheap pass is a filter, not an oracle.

    /v1/artists/{id}/albums does not return side-project or collaboration
    releases, so a track can be absent from an artist's album list and still
    be theirs. Two deadmau5 tracks released as Kx5 were flagged this way --
    2 of 6 spot-checks against production were false positives.
    """

    def test_candidate_vindicated_by_its_own_credits_is_not_deleted(self, db, monkeypatch):
        db["tracks"] = [
            {"id": 20, "name": "pwdr Blu", "spotify_track_id": "kx5a", "artist_id": 1},
        ]
        _stub_fetch(monkeypatch, ["only-solo-album-track"])
        # Spotify says deadmau5 *is* credited, via the Kx5 release.
        _stub_confirm(monkeypatch, {"kx5a": [
            {"id": "KX5", "name": "Kx5"},
            {"id": "SP1", "name": "Real Artist"},
        ]})
        s = CP.run_catalog_prune("tok", apply=True)
        assert s["candidates"] == 1
        assert s["misattributed"] == 0
        assert s["cleared_by_confirmation"] == 1
        assert db["deleted"] == [], "a vindicated track must survive"

    def test_candidate_confirmed_wrong_is_deleted(self, db, monkeypatch):
        db["tracks"] = [{"id": 21, "name": "Nessun dorma", "spotify_track_id": "op1", "artist_id": 1}]
        _stub_fetch(monkeypatch, ["a"])
        _stub_confirm(monkeypatch, {"op1": [{"id": "PUCCINI", "name": "Giacomo Puccini"}]})
        s = CP.run_catalog_prune("tok", apply=True)
        assert s["misattributed"] == 1
        assert db["deleted"] == [21]

    def test_unresolvable_candidate_is_left_alone(self, db, monkeypatch):
        db["tracks"] = [{"id": 22, "name": "Gone", "spotify_track_id": "missing", "artist_id": 1}]
        _stub_fetch(monkeypatch, ["a"])
        monkeypatch.setattr(CP, "fetch_full_tracks", lambda *a, **k: {})
        s = CP.run_catalog_prune("tok", apply=True)
        assert s["misattributed"] == 0
        assert s["cleared_by_confirmation"] == 1
        assert db["deleted"] == [], "no verdict means no deletion"
