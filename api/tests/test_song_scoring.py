"""Unit tests for the pure scoring/lane/strategy helpers in song_scoring.

These run without a database or any provider keys.
"""

from datetime import datetime, timezone

from app.services.song_scoring import (
    DEFAULT_DISCOVERY_MIX,
    DISCOVERY_LANES,
    _artist_recognizability,
    _candidate_key,
    _clean_strategy,
    _deep_cut_quality,
    _freshness_strategy_multiplier,
    _genre_strategy_multiplier,
    _genre_tokens_for_prompt,
    _lane_for_track,
    _lane_targets,
    _novelty_score,
    _release_age_days,
    _track_reach,
    _track_recognizability,
    _within_artist_recognizability,
    classify_prompt,
)


class TestClassifyPrompt:
    def test_genre_prompt(self):
        assert classify_prompt("alternative rock") == "genre"

    def test_mood_prompt(self):
        assert classify_prompt("sad night drive") == "mood"

    def test_empty_is_semantic(self):
        assert classify_prompt("   ") == "semantic"
        assert classify_prompt("the and or") == "semantic"


class TestGenreTokens:
    def test_extracts_known_genre_tokens(self):
        assert _genre_tokens_for_prompt("alternative rock") == ["alternative", "rock"]

    def test_expands_synonyms(self):
        tokens = _genre_tokens_for_prompt("edm")
        assert "electronic" in tokens and "dance" in tokens

    def test_none_for_non_genre(self):
        assert _genre_tokens_for_prompt("happy vibes") is None
        assert _genre_tokens_for_prompt(None) is None


class TestReleaseAge:
    def test_parses_iso_date(self):
        now = datetime(2026, 1, 1, tzinfo=timezone.utc)
        assert _release_age_days("2025-01-01", now) == 365

    def test_clamps_future_to_zero(self):
        now = datetime(2026, 1, 1, tzinfo=timezone.utc)
        assert _release_age_days("2030-01-01", now) == 0

    def test_none_on_garbage(self):
        now = datetime(2026, 1, 1, tzinfo=timezone.utc)
        assert _release_age_days("not-a-date", now) is None
        assert _release_age_days(None, now) is None


class TestLaneForTrack:
    def test_low_popularity_is_deep_cut(self):
        assert _lane_for_track(0.2, [], [], 0.0, None) == "deep_cuts"

    def test_high_pop_old_is_radio_hit(self):
        assert _lane_for_track(0.85, [], [], 0.0, 2000) == "radio_hits"

    def test_newish_high_pop_stays_popular(self):
        # is_newish (<=540 days) blocks the radio_hits classification
        assert _lane_for_track(0.85, [], [], 0.0, 100) == "popular"

    def test_low_reach_indie_track_is_a_deep_cut(self):
        assert _lane_for_track(0.3, ["indie"], [], 0.0, 3000) == "deep_cuts"

    def test_indie_genre_alone_does_not_bury_a_well_known_song(self):
        # An indie artist's signature song belongs in radio_hits. Keying the
        # deep-cut signal off the genre alone mislabeled it and made it
        # compete for the wrong lane's slots.
        assert _lane_for_track(0.9, ["indie"], [], 0.0, 3000) == "radio_hits"

    def test_editorial_only_deepens_low_reach_tracks(self):
        assert _lane_for_track(0.3, [], [], 0.5, 3000) == "deep_cuts"
        assert _lane_for_track(0.9, [], [], 0.5, 3000) == "radio_hits"


class TestTrackReach:
    def test_prefers_lastfm_listeners(self):
        import math

        reach = _track_reach({"lastfm_listeners": 1000, "popularity": 10})
        assert reach == math.log1p(1000)

    def test_zero_listeners_is_not_evidence_of_obscurity(self):
        # 0 means "looked up on Last.fm, not found" — fall through to
        # popularity rather than ranking the track at the bottom.
        assert _track_reach({"lastfm_listeners": 0, "popularity": 80}) is not None
        assert _track_reach({"lastfm_listeners": 0, "popularity": 80}) > 0

    def test_unranked_track_is_unknown_not_zero(self):
        assert _track_reach({"name": "Untouched"}) is None

    def test_popularity_and_listeners_are_comparable(self):
        # A mixed catalog (album-sourced rows carry listeners, search-sourced
        # rows carry popularity) must still rank as one list.
        big_by_listeners = _track_reach({"lastfm_listeners": 4_000_000})
        small_by_popularity = _track_reach({"popularity": 20})
        assert big_by_listeners > small_by_popularity


class TestTrackRecognizability:
    def test_empty_below_min_pool(self):
        tracks = [{"id": i, "lastfm_listeners": i * 100} for i in range(1, 5)]
        assert _track_recognizability(tracks, min_pool=25) == {}

    def test_ranks_pool_by_reach(self):
        tracks = [{"id": i, "lastfm_listeners": i * 1000} for i in range(1, 31)]
        ranked = _track_recognizability(tracks, min_pool=25)
        assert ranked[30] == 1.0
        assert ranked[1] == 0.0
        assert ranked[30] > ranked[15] > ranked[1]


class TestWithinArtistRecognizability:
    def test_ranks_each_catalog_independently(self):
        tracks = [
            # A small artist and a huge artist. Within-catalog percentiles
            # must be scale-free so the small artist's best song still wins
            # its own shortlist.
            {"id": 1, "artist_id": 10, "lastfm_listeners": 100},
            {"id": 2, "artist_id": 10, "lastfm_listeners": 5_000},
            {"id": 3, "artist_id": 10, "lastfm_listeners": 500},
            {"id": 4, "artist_id": 20, "lastfm_listeners": 1_000_000},
            {"id": 5, "artist_id": 20, "lastfm_listeners": 9_000_000},
            {"id": 6, "artist_id": 20, "lastfm_listeners": 3_000_000},
        ]
        ranked = _within_artist_recognizability(tracks)
        assert ranked[2] == 1.0  # small artist's best
        assert ranked[5] == 1.0  # huge artist's best
        assert ranked[1] == 0.0
        assert ranked[4] == 0.0

    def test_skips_catalogs_too_small_to_rank(self):
        tracks = [
            {"id": 1, "artist_id": 10, "lastfm_listeners": 100},
            {"id": 2, "artist_id": 10, "lastfm_listeners": 500},
        ]
        assert _within_artist_recognizability(tracks, min_catalog=3) == {}

    def test_ignores_tracks_with_no_reach_signal(self):
        tracks = [
            {"id": 1, "artist_id": 10, "lastfm_listeners": 100},
            {"id": 2, "artist_id": 10, "lastfm_listeners": 500},
            {"id": 3, "artist_id": 10, "lastfm_listeners": 900},
            {"id": 4, "artist_id": 10},
        ]
        ranked = _within_artist_recognizability(tracks)
        assert 4 not in ranked
        assert ranked[3] == 1.0


class TestNoveltyScore:
    def test_in_range(self):
        for pop in (0.0, 0.5, 1.0):
            score = _novelty_score(pop, 0.5, False, False, 100)
            assert 0.0 <= score <= 1.0

    def test_library_penalty(self):
        outside = _novelty_score(0.3, 0.2, in_library=False, is_library_artist=False, release_age_days=None)
        inside = _novelty_score(0.3, 0.2, in_library=True, is_library_artist=False, release_age_days=None)
        assert inside < outside

    def test_lower_popularity_scores_higher(self):
        low = _novelty_score(0.1, 0.0, False, False, None)
        high = _novelty_score(0.9, 0.0, False, False, None)
        assert low > high


class TestDeepCutQuality:
    def test_in_range_and_monotonic_in_affinity(self):
        low = _deep_cut_quality(0.2, 0.1, 0.1, 0.1, False, False)
        high = _deep_cut_quality(0.2, 0.1, 0.1, 0.9, False, False)
        assert 0.0 <= low <= high <= 1.0


class TestStrategyMultipliers:
    def test_genre_boost_and_avoid(self):
        strat = {"genre_boosts": ["jazz"], "genre_avoids": ["metal"]}
        assert _genre_strategy_multiplier(["jazz", "soul"], strat) > 1.0
        assert _genre_strategy_multiplier(["metal"], strat) < 1.0

    def test_genre_multiplier_clamped(self):
        strat = {"genre_boosts": ["a", "b", "c", "d", "e"], "genre_avoids": []}
        assert _genre_strategy_multiplier(["a b c d e"], strat) <= 1.28

    def test_freshness_newer_boosts_recent(self):
        assert _freshness_strategy_multiplier(100, 0.5, {"freshness": "newer"}) > 1.0

    def test_freshness_timeless_boosts_popular(self):
        assert _freshness_strategy_multiplier(5000, 0.8, {"freshness": "timeless"}) > 1.0

    def test_balanced_is_neutral(self):
        assert _freshness_strategy_multiplier(100, 0.5, {"freshness": "balanced"}) == 1.0


class TestCleanStrategy:
    def test_non_dict_returns_empty(self):
        assert _clean_strategy(None) == {}
        assert _clean_strategy("nope") == {}

    def test_defaults_and_clamping(self):
        cleaned = _clean_strategy({"genre_boosts": ["JAZZ", "jazz", ""], "station_distance": "bogus"})
        assert cleaned["genre_boosts"] == ["jazz"]  # deduped + lowercased
        assert cleaned["station_distance"] == "balanced"  # invalid -> default
        assert cleaned["discovery_mix"] == DEFAULT_DISCOVERY_MIX

    def test_caps_genre_lists_at_12(self):
        cleaned = _clean_strategy({"genre_boosts": [f"g{i}" for i in range(40)]})
        assert len(cleaned["genre_boosts"]) == 12


class TestLaneTargets:
    def test_zero_limit(self):
        assert _lane_targets(0) == {lane: 0 for lane in DISCOVERY_LANES}

    def test_targets_sum_to_limit(self):
        targets = _lane_targets(30)
        assert sum(targets.values()) == 30

    def test_respects_custom_mix(self):
        targets = _lane_targets(
            30, {"discovery_mix": {"deep_cuts": 100, "popular": 0, "radio_hits": 0}}
        )
        # An all-deep-cuts mix concentrates the targets in that lane. The forced
        # max(1, ...) minimum for radio_hits when limit >= 3 means the targets
        # can sum to limit + 1; the rerank truncates the final list to `limit`.
        assert sum(targets.values()) <= 31
        assert targets["deep_cuts"] >= targets["popular"]
        assert targets["deep_cuts"] >= targets["radio_hits"]


class TestCandidateKey:
    def test_key_is_normalized(self):
        assert _candidate_key({"track_name": "Song", "artist_name": "Band"}) == "song|band"

    def test_handles_missing_fields(self):
        assert _candidate_key({}) == "|"


class TestArtistRecognizability:
    @staticmethod
    def _pool(listener_counts):
        return [
            {"id": i + 1, "lastfm_listeners": count}
            for i, count in enumerate(listener_counts)
        ]

    def test_empty_input(self):
        assert _artist_recognizability([]) == {}

    def test_below_min_pool_returns_empty(self):
        # 9 artists with listeners < min_pool of 10 -> neutral fallback.
        pool = self._pool([1000 * (i + 1) for i in range(9)])
        assert _artist_recognizability(pool) == {}

    def test_null_and_zero_listeners_excluded(self):
        pool = self._pool([10_000] * 10) + [
            {"id": 100, "lastfm_listeners": None},
            {"id": 101, "lastfm_listeners": 0},
        ]
        result = _artist_recognizability(pool)
        assert 100 not in result
        assert 101 not in result

    def test_monotonic_in_listeners(self):
        pool = self._pool([1_000 * (3 ** i) for i in range(12)])
        result = _artist_recognizability(pool)
        assert len(result) == 12
        ordered = [result[i + 1] for i in range(12)]
        assert ordered == sorted(ordered)
        assert ordered[-1] == 1.0
        assert all(0.0 <= v <= 1.0 for v in ordered)

    def test_top_percentiles_reach_radio_hits_threshold(self):
        # The whole point: with a listener-diverse pool, the top of the pool
        # must clear the 0.78 radio_hits bar in _lane_for_track.
        pool = self._pool([1_000 * (2 ** i) for i in range(20)])
        result = _artist_recognizability(pool)
        assert max(result.values()) >= 0.78
        assert min(result.values()) < 0.46  # and the bottom reaches deep_cuts
