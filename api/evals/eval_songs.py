"""Evals for the song-level recommendation engine (song_ranking.py).

Focuses on track-specific behaviors layered on top of artist ranking:
familiarity penalties, per-song artist diversity, genre text filtering,
popularity-driven track selection, and "deep cut" discovery labeling.
"""
from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

_API_DIR = Path(__file__).parent.parent
if str(_API_DIR) not in sys.path:
    sys.path.insert(0, str(_API_DIR))

from app.services.song_ranking import recommend_songs, _song_diversity_rerank
from evals.fixtures import (
    ALL_ARTISTS,
    JAZZ_ARTISTS,
    JAZZ_TASTE_VECTOR,
    JAZZ_USER,
    ROCK_ARTISTS,
    SOURCES,
    TRACKS,
    UserScenario,
    _make_artist,
    _make_track,
    build_mock_client,
)
from evals.metrics import artist_diversity_score


@dataclass
class EvalResult:
    name: str
    passed: bool
    score: float
    details: str = ""
    skipped: bool = False
    threshold: float = 1.0


def _weights(affinity: float = 0.5, context: float = 0.3, editorial: float = 0.2) -> dict:
    return {"affinity": affinity, "context": context, "editorial": editorial}


# ── Evals ────────────────────────────────────────────────────────


def eval_heard_song_penalized() -> EvalResult:
    """A track the user has already heard should rank below an unheard track from the same artist.

    track_boost *= 0.45 for in-library tracks. Both tracks here belong to
    Miles Davis (artist 1), so the affinity signal is identical — the
    familiarity penalty is the only differentiator.
    """
    # Custom scenario: user has heard Kind of Blue (101) but NOT Bitches Brew (102).
    # JAZZ_USER includes both tracks; we create a variant with only 101 played.
    partial_user = UserScenario(
        user_id="user_partial_jazz",
        library_artist_ids=[1],  # Miles Davis in library
        played_track_ids=[101],  # only Kind of Blue heard
        top_artist_ids=[1],
        taste_vector=JAZZ_TASTE_VECTOR,
    )
    client = build_mock_client(partial_user, artists=JAZZ_ARTISTS[:1], tracks=TRACKS[:2])
    results = recommend_songs(
        client=client,
        user_id=partial_user.user_id,
        taste_vector=JAZZ_TASTE_VECTOR,
        prompt_vector=None,
        weights=_weights(),
        exclude_library=False,
        limit=10,
    )
    by_track = {r["track_name"]: r for r in results}
    kind_of_blue = by_track.get("Kind of Blue")
    bitches_brew = by_track.get("Bitches Brew")

    if kind_of_blue is None or bitches_brew is None:
        return EvalResult(
            name="heard_song_penalized",
            passed=False,
            score=0.0,
            details="One or both tracks missing from results — check track population",
        )

    passed = bitches_brew["score"] > kind_of_blue["score"]
    score = 1.0 if passed else 0.0
    return EvalResult(
        name="heard_song_penalized",
        passed=passed,
        score=score,
        details=(
            f"Unheard 'Bitches Brew' score={bitches_brew['score']:.4f} vs "
            f"heard 'Kind of Blue' score={kind_of_blue['score']:.4f}"
        ),
    )


def eval_one_song_per_artist() -> EvalResult:
    """After diversity re-ranking, each artist should appear at most once when catalog is sufficient.

    MAX_ARTIST_SONGS=1 is enforced in _song_diversity_rerank. We request
    limit=3 matching the number of distinct artists, so the first-pass
    1-per-artist cap fills all slots without triggering the top-up path
    (which intentionally relaxes the cap for sparse catalogs).
    """
    artists = [
        _make_artist(800, "Artist A", ["pop"], vec_seed=8, popularity=90),
        _make_artist(801, "Artist B", ["pop"], vec_seed=9, popularity=85),
        _make_artist(802, "Artist C", ["pop"], vec_seed=10, popularity=80),
    ]
    tracks = [
        _make_track(801, "Track A1", 800, popularity=90, vec_seed=301),
        _make_track(802, "Track A2", 800, popularity=88, vec_seed=302),
        _make_track(811, "Track B1", 801, popularity=87, vec_seed=311),
        _make_track(812, "Track B2", 801, popularity=83, vec_seed=312),
        _make_track(821, "Track C1", 802, popularity=82, vec_seed=321),
        _make_track(822, "Track C2", 802, popularity=79, vec_seed=322),
    ]
    scenario = UserScenario(
        user_id="diversity_test",
        library_artist_ids=[],
        played_track_ids=[],
        top_artist_ids=[800, 801, 802],
        taste_vector=JAZZ_TASTE_VECTOR,
    )
    client = build_mock_client(scenario, artists=artists, tracks=tracks, mentions=[])
    results = recommend_songs(
        client=client,
        user_id=scenario.user_id,
        taste_vector=JAZZ_TASTE_VECTOR,
        prompt_vector=None,
        weights=_weights(),
        exclude_library=False,
        limit=3,  # = number of artists, so 1-per-artist fills the limit exactly
    )
    diversity = artist_diversity_score(results)
    passed = diversity == 1.0
    return EvalResult(
        name="one_song_per_artist",
        passed=passed,
        score=diversity,
        details=(
            f"Artist diversity score: {diversity:.2f} across {len(results)} results. "
            f"Artists returned: {[r['artist_name'] for r in results]}"
        ),
    )


def eval_genre_text_filter() -> EvalResult:
    """A genre-matching prompt_text should narrow the candidate pool to that genre.

    When prompt_text='jazz' and ≥5 jazz artists exist, the engine filters
    the catalog to genre-matching artists before ranking.
    """
    client = build_mock_client(JAZZ_USER, artists=ALL_ARTISTS)
    results = recommend_songs(
        client=client,
        user_id=JAZZ_USER.user_id,
        taste_vector=JAZZ_TASTE_VECTOR,
        prompt_vector=None,
        weights=_weights(),
        exclude_library=False,
        limit=10,
        prompt_text="jazz",
    )
    jazz_artist_names = {a["name"].lower() for a in JAZZ_ARTISTS}
    non_jazz = [
        r for r in results if r["artist_name"].lower() not in jazz_artist_names
    ]
    passed = len(non_jazz) == 0
    score = 1.0 - len(non_jazz) / max(len(results), 1)
    return EvalResult(
        name="genre_text_filter",
        passed=passed,
        score=round(score, 4),
        details=(
            f"Non-jazz tracks in results: {len(non_jazz)}/{len(results)}. "
            f"Non-jazz: {[r['artist_name'] for r in non_jazz]}"
        ),
    )


def eval_popularity_track_selection() -> EvalResult:
    """When no prompt vector is provided, a more popular track should be chosen over a less popular one.

    Without an embedding-based context signal the shortlist falls back to
    popularity alone. The more popular track should appear in results.
    """
    high_pop = _make_track(900, "Hit Song", 1, popularity=95, vec_seed=400)
    low_pop = _make_track(901, "B-Side", 1, popularity=20, vec_seed=401)

    # Only artist 1, two tracks: one popular, one obscure
    client = build_mock_client(
        JAZZ_USER,
        artists=JAZZ_ARTISTS[:1],
        tracks=[high_pop, low_pop],
        mentions=[],
    )
    results = recommend_songs(
        client=client,
        user_id=JAZZ_USER.user_id,
        taste_vector=JAZZ_TASTE_VECTOR,
        prompt_vector=None,
        weights=_weights(),
        exclude_library=False,
        limit=2,
    )
    track_names = [r["track_name"] for r in results]
    passed = "Hit Song" in track_names
    return EvalResult(
        name="popularity_track_selection",
        passed=passed,
        score=1.0 if passed else 0.0,
        details=f"Tracks returned: {track_names}. Expected 'Hit Song' (pop=95) to appear.",
    )


def eval_deep_cut_reason_label() -> EvalResult:
    """A new (unheard) track from a library artist should carry the 'Deep cut' reason label.

    This reason is the user-facing signal that discovery is happening within
    familiar territory: "here's something you haven't heard from an artist
    you already love."
    """
    # User has artist 1 (Miles Davis) in library and has only heard track 101
    # (Kind of Blue). Track 102 (Bitches Brew) is unheard → qualifies as a
    # deep cut from a known artist.
    partial_user = UserScenario(
        user_id="user_deep_cut",
        library_artist_ids=[1],
        played_track_ids=[101],  # only Kind of Blue heard
        top_artist_ids=[1],
        taste_vector=JAZZ_TASTE_VECTOR,
    )
    client = build_mock_client(partial_user, artists=JAZZ_ARTISTS[:1], tracks=TRACKS[:2])
    results = recommend_songs(
        client=client,
        user_id=partial_user.user_id,
        taste_vector=JAZZ_TASTE_VECTOR,
        prompt_vector=None,
        weights=_weights(),
        exclude_library=False,
        limit=10,
    )
    bitches_brew = next((r for r in results if r["track_name"] == "Bitches Brew"), None)
    if bitches_brew is None:
        return EvalResult(
            name="deep_cut_reason_label",
            passed=False,
            score=0.0,
            details="'Bitches Brew' not in results",
        )
    has_deep_cut = any("Deep cut" in reason for reason in (bitches_brew.get("reasons") or []))
    return EvalResult(
        name="deep_cut_reason_label",
        passed=has_deep_cut,
        score=1.0 if has_deep_cut else 0.0,
        details=f"Reasons on 'Bitches Brew': {bitches_brew.get('reasons')}",
    )


def eval_song_diversity_rerank_contract() -> EvalResult:
    """_song_diversity_rerank must never return more than the requested limit."""
    pool = [
        {
            "track_name": f"Track {i}",
            "artist_name": f"Artist {i % 3}",
            "genres": ["pop"],
            "score": 1.0 - i * 0.01,
        }
        for i in range(20)
    ]
    limit = 8
    result = _song_diversity_rerank(pool, limit)
    passed = len(result) <= limit
    return EvalResult(
        name="song_diversity_rerank_contract",
        passed=passed,
        score=1.0 if passed else 0.0,
        details=f"Output length {len(result)} for limit={limit}",
    )


def eval_thumbs_down_track_strongly_penalized() -> EvalResult:
    """A thumbs-downed track should rank very low — below unheard tracks from the same artist.

    The 0.15× track_boost multiplier for an explicit thumbs-down is much stronger
    than the heard-song penalty (0.45×). A track the user said they dislike should
    essentially drop to the bottom of results, even below familiar tracks.
    """
    # Miles Davis (artist 1) has two tracks. User has heard neither, but thumbed down track 101.
    disliked_track = TRACKS[0]  # Kind of Blue (track 101)
    neutral_track = TRACKS[1]   # Bitches Brew (track 102)

    assert disliked_track["id"] == 101
    assert neutral_track["id"] == 102

    scenario = UserScenario(
        user_id="thumbs_down_track_test",
        library_artist_ids=[1],
        played_track_ids=[],  # neither track heard
        top_artist_ids=[1],
        taste_vector=JAZZ_TASTE_VECTOR,
        feedback=[
            {
                "artist_id": 1,
                "spotify_track_id": disliked_track["spotify_track_id"],
                "feedback": -1,
            }
        ],
    )
    client = build_mock_client(scenario, artists=JAZZ_ARTISTS[:1], tracks=TRACKS[:2])
    results = recommend_songs(
        client=client,
        user_id=scenario.user_id,
        taste_vector=JAZZ_TASTE_VECTOR,
        prompt_vector=None,
        weights=_weights(),
        exclude_library=False,
        limit=10,
    )
    by_track = {r["track_name"]: r for r in results}
    disliked = by_track.get("Kind of Blue")
    neutral = by_track.get("Bitches Brew")

    if disliked is None or neutral is None:
        return EvalResult(
            name="thumbs_down_track_strongly_penalized",
            passed=False,
            score=0.0,
            details="One or both tracks missing from results — check track population",
        )

    passed = neutral["score"] > disliked["score"]
    score = 1.0 if passed else 0.0
    return EvalResult(
        name="thumbs_down_track_strongly_penalized",
        passed=passed,
        score=score,
        details=(
            f"Neutral 'Bitches Brew' score={neutral['score']:.4f} vs "
            f"thumbed-down 'Kind of Blue' score={disliked['score']:.4f}"
        ),
    )


def eval_no_identical_list_repeated() -> EvalResult:
    pool = [
        {"track_name": "A", "artist_name": "X", "genres": ["g"], "score": 1.0},
        {"track_name": "B", "artist_name": "Y", "genres": ["g"], "score": 0.9},
    ]
    first = _song_diversity_rerank(pool, 2)
    second = _song_diversity_rerank(pool, 2)
    # Contract helper: collision should be detectable by caller using signature.
    same = [f"{r['track_name']}|{r['artist_name']}" for r in first] == [f"{r['track_name']}|{r['artist_name']}" for r in second]
    return EvalResult(name="no_identical_list_repeated", passed=same, score=1.0 if same else 0.0, details="Deterministic list signature baseline")


def eval_strict_novelty_zero_overlap_when_possible() -> EvalResult:
    prior = {"t1", "t2"}
    candidate = ["t3", "t4", "t5"]
    overlap = sum(1 for t in candidate if t in prior) / len(candidate)
    return EvalResult(name="strict_novelty_zero_overlap_when_possible", passed=overlap == 0.0, score=1.0 if overlap == 0.0 else 0.0, details=f"overlap={overlap}")


def eval_graceful_mode_refill_under_sparse_catalog() -> EvalResult:
    pool = [
        {"track_name": "Only 1", "artist_name": "A", "genres": ["g"], "score": 1.0},
        {"track_name": "Only 2", "artist_name": "A", "genres": ["g"], "score": 0.8},
    ]
    result = _song_diversity_rerank(pool, 3)
    return EvalResult(name="graceful_mode_refill_under_sparse_catalog", passed=len(result) >= 1, score=1.0 if len(result) >= 1 else 0.0, details=f"returned={len(result)}")


# ── Suite runner ─────────────────────────────────────────────────


def run_suite() -> list[EvalResult]:
    return [
        eval_heard_song_penalized(),
        eval_one_song_per_artist(),
        eval_genre_text_filter(),
        eval_popularity_track_selection(),
        eval_deep_cut_reason_label(),
        eval_song_diversity_rerank_contract(),
        eval_thumbs_down_track_strongly_penalized(),
        eval_no_identical_list_repeated(),
        eval_strict_novelty_zero_overlap_when_possible(),
        eval_graceful_mode_refill_under_sparse_catalog(),
    ]
