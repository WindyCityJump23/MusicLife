"""Unit tests for utility-track filtering (Python twin of web/lib/track-quality.ts)."""

from app.services.song_scoring import _favorites_boost
from app.services.track_quality import (
    has_utility_title,
    is_utility_artist_name,
    should_exclude_utility_track,
)


class TestUtilityArtistName:
    def test_catches_playlist_farm_names_observed_live(self):
        assert is_utility_artist_name("Clean Pop Music")
        assert is_utility_artist_name("Synthwave Nation")
        assert is_utility_artist_name("summer sax")
        # Mood-farm names that flooded mood-prompt searches (June 2026).
        assert is_utility_artist_name("Soft Soundscapes")
        assert is_utility_artist_name("Cozy Coffee Shop")
        assert is_utility_artist_name("Restaurant Lounge Background Music")
        assert is_utility_artist_name("Cozy Nordic")

    def test_keeps_real_artists_with_generic_words(self):
        assert not is_utility_artist_name("Clean Bandit")
        assert not is_utility_artist_name("Nation of Language")
        assert not is_utility_artist_name("Summer Walker")
        assert not is_utility_artist_name("Beach House")
        assert not is_utility_artist_name("Pop Smoke")
        assert not is_utility_artist_name("The Band")  # 'band' is not generic here
        # Real artists containing the new mood-farm tokens stay safe.
        assert not is_utility_artist_name("Soft Cell")
        assert not is_utility_artist_name("Barry White")
        assert not is_utility_artist_name("Moody Blues")
        assert not is_utility_artist_name("bar italia")

    def test_single_word_names_never_match(self):
        assert not is_utility_artist_name("Music")
        assert not is_utility_artist_name("Karaoke")

    def test_empty_and_none(self):
        assert not is_utility_artist_name("")
        assert not is_utility_artist_name(None)


class TestUtilityTitle:
    def test_catches_no_lyrics_misspelling(self):
        assert has_utility_title({"name": "Study Pop No Lyricss"})

    def test_catches_chill_radio_albums(self):
        assert has_utility_title({"name": "Synthwave Mix", "album_name": "Synthwave Radio"})

    def test_keeps_normal_tracks(self):
        assert not has_utility_title({"name": "Kiss City", "album_name": "Blondshell"})
        assert not has_utility_title({"name": "Radio", "album_name": "Songs of Leonard Cohen"})


class TestShouldExclude:
    def test_artist_name_check_applies_when_present(self):
        assert should_exclude_utility_track({"name": "Africa", "artist_name": "summer sax"})

    def test_absent_artist_name_is_noop(self):
        assert not should_exclude_utility_track({"name": "Africa"})


class TestFavoritesBoost:
    def test_neutral_without_signal(self):
        assert _favorites_boost(None) == 1.0

    def test_neutral_below_floor(self):
        assert _favorites_boost(0.2) == 1.0
        assert _favorites_boost(0.45) == 1.0

    def test_monotonic_and_bounded(self):
        low = _favorites_boost(0.5)
        mid = _favorites_boost(0.75)
        high = _favorites_boost(1.0)
        assert 1.0 < low < mid < high <= 1.25

    def test_clamps_out_of_range_similarity(self):
        assert _favorites_boost(5.0) == _favorites_boost(1.0)
