"""Regression tests for the track-recognizability fixes (follow-up to PR #104).

Two P1s surfaced in review after that PR merged:

  1. ``_fetch_tracks_for_artist_ids`` names ``lastfm_listeners`` explicitly, so
     against a database without migration 030 PostgREST rejects the whole
     request and /recommend/songs fails rather than degrading to artist-level
     recognizability.
  2. ``_percentile_rank`` gave tied values different percentiles based on input
     order, which matters now that it ranks integer Last.fm listener counts.
"""

import pytest

from app.services import song_ranking
from app.services.ranking import _percentile_rank


class _UndefinedColumn(Exception):
    """Shape of the PostgREST error for Postgres SQLSTATE 42703."""

    def __init__(self) -> None:
        super().__init__(
            "column tracks.lastfm_listeners does not exist"
        )
        self.code = "42703"


class _FakeQuery:
    def __init__(self, table: "_FakeTable", columns: str) -> None:
        self._table = table
        self._columns = columns

    def in_(self, *_args, **_kwargs) -> "_FakeQuery":
        return self

    def range(self, *_args, **_kwargs) -> "_FakeQuery":
        return self

    def execute(self):
        self._table.attempted.append(self._columns)
        if "lastfm_listeners" in self._columns and not self._table.has_column:
            raise self._table.error_factory()

        class _Resp:
            pass

        resp = _Resp()
        row = {"id": 1, "name": "Song", "artist_id": 7, "popularity": None}
        if "lastfm_listeners" in self._columns:
            row["lastfm_listeners"] = 4321
        resp.data = [row]
        return resp


class _FakeTable:
    def __init__(self, has_column: bool, error_factory=_UndefinedColumn) -> None:
        self.has_column = has_column
        self.error_factory = error_factory
        self.attempted: list[str] = []

    def select(self, columns: str) -> _FakeQuery:
        return _FakeQuery(self, columns)


class _FakeClient:
    def __init__(self, table: _FakeTable) -> None:
        self._table = table

    def table(self, _name: str) -> _FakeTable:
        return self._table


@pytest.fixture(autouse=True)
def reset_probe():
    """The missing-column probe is cached per process; isolate each test."""
    song_ranking._track_reach_column_available = True
    yield
    song_ranking._track_reach_column_available = True


class TestPreMigrationFallback:
    def test_uses_the_reach_column_when_it_exists(self):
        table = _FakeTable(has_column=True)
        rows = song_ranking._fetch_tracks_for_artist_ids(_FakeClient(table), [7])
        assert rows[0]["lastfm_listeners"] == 4321
        assert len(table.attempted) == 1, "should not retry when the column exists"

    def test_falls_back_instead_of_failing_the_request(self):
        table = _FakeTable(has_column=False)
        rows = song_ranking._fetch_tracks_for_artist_ids(_FakeClient(table), [7])
        # Degraded, not dead: rows still come back, just without the column.
        assert rows and "lastfm_listeners" not in rows[0]
        assert len(table.attempted) == 2, "should retry once without the column"

    def test_missing_column_probe_is_cached(self):
        table = _FakeTable(has_column=False)
        client = _FakeClient(table)
        song_ranking._fetch_tracks_for_artist_ids(client, [7])
        table.attempted.clear()
        song_ranking._fetch_tracks_for_artist_ids(client, [7])
        assert table.attempted == [song_ranking._TRACK_COLUMNS_BASE], (
            "a known-missing column should not be re-probed on every request"
        )

    def test_unrelated_errors_still_propagate(self):
        # Swallowing a connection or auth failure here would silently serve
        # degraded results for a problem that has nothing to do with schema.
        class _Boom(Exception):
            pass

        table = _FakeTable(has_column=False, error_factory=_Boom)
        with pytest.raises(_Boom):
            song_ranking._fetch_tracks_for_artist_ids(_FakeClient(table), [7])


class TestPercentileRankTies:
    def test_equal_values_share_a_percentile(self):
        ranks = _percentile_rank([100.0] * 5 + [200.0] * 5)
        assert len(set(ranks[:5])) == 1
        assert len(set(ranks[5:])) == 1
        assert ranks[0] < ranks[5]

    def test_tied_run_does_not_straddle_lane_thresholds(self):
        # Duplicate single/album releases carry one Last.fm listener count.
        # Previously these spread across 0.00-0.44 and landed in different
        # lanes; the deep-cuts cut-off is 0.46 and radio-hits is 0.78.
        ranks = _percentile_rank([1000.0] * 8 + [9_000_000.0] * 2)
        tied = ranks[:8]
        assert len(set(tied)) == 1
        assert all((r < 0.46) == (tied[0] < 0.46) for r in tied)

    def test_untied_values_are_unchanged(self):
        assert _percentile_rank([1, 2, 3, 4, 5]) == [0.0, 0.25, 0.5, 0.75, 1.0]

    def test_all_equal_values_are_neutral(self):
        assert _percentile_rank([7.0] * 4) == [0.5, 0.5, 0.5, 0.5]

    def test_order_independent(self):
        forward = _percentile_rank([5, 1, 5, 3, 1])
        assert forward[0] == forward[2]
        assert forward[1] == forward[4]
        assert forward[1] < forward[3] < forward[0]

    def test_degenerate_inputs(self):
        assert _percentile_rank([]) == []
        assert _percentile_rank([9.0]) == [1.0]
