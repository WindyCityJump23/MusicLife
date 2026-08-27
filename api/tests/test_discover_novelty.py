"""Unit tests for the pure novelty math in discover_novelty.

No database access — these exercise signatures, exclusion sets, and overlap
ratios that guard against repeated stations.
"""

from datetime import datetime, timedelta, timezone

from app.services.discover_novelty import (
    artist_overlap_ratio,
    build_excluded_artist_ids,
    build_excluded_track_ids,
    overlap_ratio,
    set_hash_from_sorted,
    signature_from_ordered,
)


def _iso(days_ago: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat()


class TestSignatures:
    def test_order_sensitive_signature(self):
        assert signature_from_ordered(["a", "b"]) != signature_from_ordered(["b", "a"])

    def test_set_hash_is_order_insensitive(self):
        assert set_hash_from_sorted(["a", "b"]) == set_hash_from_sorted(["b", "a"])

    def test_whitespace_and_blanks_normalized(self):
        assert signature_from_ordered([" a ", "", "b"]) == signature_from_ordered(["a", "b"])


class TestOverlapRatios:
    def test_track_overlap(self):
        assert overlap_ratio(["a", "b", "c", "d"], {"a", "b"}) == 0.5

    def test_empty_candidates_is_zero(self):
        assert overlap_ratio([], {"a"}) == 0.0

    def test_artist_overlap(self):
        assert artist_overlap_ratio([1, 2, 3, 4], {1, 2}) == 0.5
        assert artist_overlap_ratio([], {1}) == 0.0


class TestExclusionSets:
    def test_collects_track_ids_across_runs(self):
        rows = [{"track_ids": ["a", "b"]}, {"track_ids": ["b", "c"]}]
        assert build_excluded_track_ids(rows) == {"a", "b", "c"}

    def test_collects_artist_ids_and_coerces_int(self):
        rows = [{"artist_ids": [1, "2", None, "bad"]}]
        assert build_excluded_artist_ids(rows) == {1, 2}

    def test_artist_exclusion_only_spans_the_most_recent_runs(self):
        # history_rows arrive newest-first. Banning every artist across the
        # full 15-run window blacklisted more artists than most libraries
        # have strong matches for, which pushed the ranker into the tail.
        rows = [{"artist_ids": [i]} for i in range(10)]
        excluded = build_excluded_artist_ids(rows)
        assert excluded == {0, 1, 2, 3}, "should keep only ARTIST_NOVELTY_RUNS newest runs"

    def test_artist_exclusion_window_is_overridable(self):
        rows = [{"artist_ids": [i]} for i in range(10)]
        assert build_excluded_artist_ids(rows, max_runs=None) == set(range(10))
        assert build_excluded_artist_ids(rows, max_runs=2) == {0, 1}

    def test_track_exclusion_still_spans_the_full_window(self):
        # Tracks stay excluded across the whole history — hearing the same
        # song again is what listeners actually notice.
        rows = [{"track_ids": [f"t{i}"]} for i in range(10)]
        assert build_excluded_track_ids(rows) == {f"t{i}" for i in range(10)}

    def test_older_than_days_filters_old_runs(self):
        rows = [
            {"track_ids": ["recent"], "created_at": _iso(1)},
            {"track_ids": ["old"], "created_at": _iso(40)},
        ]
        # only keep runs newer than 3 days
        assert build_excluded_track_ids(rows, older_than_days=3) == {"recent"}
