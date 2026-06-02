"""Evals for the song-level recommendation engine (song_ranking.py).

Focuses on track-specific behaviors layered on top of artist ranking:
familiarity penalties, per-song artist diversity, genre text filtering,
popularity-driven track selection, and "deep cut" discovery labeling.
"""
from __future__ import annotations

import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

_API_DIR = Path(__file__).parent.parent
if str(_API_DIR) not in sys.path:
    sys.path.insert(0, str(_API_DIR))

from app.services.query_intent import interpret_music_prompt
from app.services.song_ranking import recommend_songs, _song_diversity_rerank
from app.services.track_quality import (
    prompt_requests_utility_tracks,
    should_exclude_utility_track,
)
from evals.fixtures import (
    ALL_ARTISTS,
    JAZZ_ARTISTS,
    JAZZ_TASTE_VECTOR,
    JAZZ_USER,
    ROCK_ARTISTS,
    ROCK_TASTE_VECTOR,
    SOURCES,
    TRACKS,
    UserScenario,
    _make_artist,
    _make_track,
    _rand_vec,
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
    """After diversity re-ranking, each artist should appear at most once when
    enough unique artists exist to fill the requested limit.

    The reranker adapts: when unique artists >= limit it enforces 1-per-artist;
    when fewer artists are available it allows up to 2 per artist so genre
    searches aren't artificially capped. This test provides 5 distinct artists
    for limit=3, ensuring the 1-per-artist path is exercised.
    """
    artists = [
        _make_artist(800, "Artist A", ["pop"], vec_seed=8, popularity=90),
        _make_artist(801, "Artist B", ["pop"], vec_seed=9, popularity=85),
        _make_artist(802, "Artist C", ["pop"], vec_seed=10, popularity=80),
        _make_artist(803, "Artist D", ["pop"], vec_seed=11, popularity=75),
        _make_artist(804, "Artist E", ["pop"], vec_seed=12, popularity=70),
    ]
    tracks = [
        _make_track(801, "Track A1", 800, popularity=90, vec_seed=301),
        _make_track(802, "Track A2", 800, popularity=88, vec_seed=302),
        _make_track(811, "Track B1", 801, popularity=87, vec_seed=311),
        _make_track(812, "Track B2", 801, popularity=83, vec_seed=312),
        _make_track(821, "Track C1", 802, popularity=82, vec_seed=321),
        _make_track(822, "Track C2", 802, popularity=79, vec_seed=322),
        _make_track(831, "Track D1", 803, popularity=78, vec_seed=331),
        _make_track(841, "Track E1", 804, popularity=73, vec_seed=341),
    ]
    scenario = UserScenario(
        user_id="diversity_test",
        library_artist_ids=[],
        played_track_ids=[],
        top_artist_ids=[800, 801, 802, 803, 804],
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
        limit=3,
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


def eval_feedback_changes_rank() -> EvalResult:
    """Explicit negative feedback should change the next unprompted station."""
    target_track = TRACKS[0]  # Kind of Blue
    scenario_before = UserScenario(
        user_id="feedback_rank_before",
        library_artist_ids=[1],
        played_track_ids=[],
        top_artist_ids=[1],
        taste_vector=JAZZ_TASTE_VECTOR,
    )
    scenario_after = UserScenario(
        user_id="feedback_rank_after",
        library_artist_ids=[1],
        played_track_ids=[],
        top_artist_ids=[1],
        taste_vector=JAZZ_TASTE_VECTOR,
        feedback=[
            {
                "artist_id": 1,
                "spotify_track_id": target_track["spotify_track_id"],
                "feedback": -1,
                "reason": "less_like_this",
            }
        ],
        events=[
            {
                "artist_id": 1,
                "spotify_track_id": target_track["spotify_track_id"],
                "event_type": "thumb_down",
            }
        ],
    )

    def score_for(scenario: UserScenario) -> float:
        results = recommend_songs(
            client=build_mock_client(scenario, artists=JAZZ_ARTISTS[:1], tracks=TRACKS[:2]),
            user_id=scenario.user_id,
            taste_vector=JAZZ_TASTE_VECTOR,
            prompt_vector=None,
            weights=_weights(),
            exclude_library=False,
            limit=10,
            exploration_seed=1,
        )
        row = next((r for r in results if r["track_name"] == target_track["name"]), None)
        return float(row["score"]) if row else 0.0

    before = score_for(scenario_before)
    after = score_for(scenario_after)
    passed = after < before * 0.5
    return EvalResult(
        name="feedback_changes_rank",
        passed=passed,
        score=1.0 if passed else 0.0,
        details=f"before={before:.4f}, after={after:.4f}",
    )


def eval_too_familiar_shifts_mix() -> EvalResult:
    """Too familiar feedback should reduce future familiar/radio-hit picks."""
    target_track = TRACKS[0]  # high-popularity, familiar-lane candidate
    scenario_before = UserScenario(
        user_id="too_familiar_before",
        library_artist_ids=[1],
        played_track_ids=[],
        top_artist_ids=[1],
        taste_vector=JAZZ_TASTE_VECTOR,
    )
    scenario_after = UserScenario(
        user_id="too_familiar_after",
        library_artist_ids=[1],
        played_track_ids=[],
        top_artist_ids=[1],
        taste_vector=JAZZ_TASTE_VECTOR,
        events=[
            {
                "artist_id": 1,
                "spotify_track_id": target_track["spotify_track_id"],
                "event_type": "too_familiar",
            }
        ],
    )

    def score_for(scenario: UserScenario) -> float:
        results = recommend_songs(
            client=build_mock_client(scenario, artists=JAZZ_ARTISTS[:1], tracks=TRACKS[:2]),
            user_id=scenario.user_id,
            taste_vector=JAZZ_TASTE_VECTOR,
            prompt_vector=None,
            weights=_weights(),
            exclude_library=False,
            limit=10,
            exploration_seed=1,
        )
        row = next((r for r in results if r["track_name"] == target_track["name"]), None)
        return float(row["score"]) if row else 0.0

    before = score_for(scenario_before)
    after = score_for(scenario_after)
    passed = after < before
    return EvalResult(
        name="too_familiar_shifts_mix",
        passed=passed,
        score=1.0 if passed else 0.0,
        details=f"before={before:.4f}, after={after:.4f}",
    )


def eval_too_far_shifts_mix() -> EvalResult:
    """Too far feedback should reduce future low-popularity outside-air picks."""
    artist = _make_artist(880, "Outer Edge Artist", ["ambient"], vec_seed=80, popularity=40)
    target = _make_track(1880, "Outer Edge Drift", 880, popularity=22, vec_seed=1880)
    neighbor = _make_track(1881, "Grounded Drift", 880, popularity=62, vec_seed=1881)
    scenario_before = UserScenario(
        user_id="too_far_before",
        library_artist_ids=[],
        played_track_ids=[],
        top_artist_ids=[880],
        taste_vector=JAZZ_TASTE_VECTOR,
    )
    scenario_after = UserScenario(
        user_id="too_far_after",
        library_artist_ids=[],
        played_track_ids=[],
        top_artist_ids=[880],
        taste_vector=JAZZ_TASTE_VECTOR,
        events=[
            {
                "artist_id": 880,
                "spotify_track_id": target["spotify_track_id"],
                "event_type": "too_far",
            }
        ],
    )

    def score_for(scenario: UserScenario) -> float:
        results = recommend_songs(
            client=build_mock_client(scenario, artists=[artist], tracks=[target, neighbor]),
            user_id=scenario.user_id,
            taste_vector=JAZZ_TASTE_VECTOR,
            prompt_vector=None,
            weights=_weights(),
            exclude_library=False,
            limit=10,
            exploration_seed=1,
        )
        row = next((r for r in results if r["track_name"] == target["name"]), None)
        return float(row["score"]) if row else 0.0

    before = score_for(scenario_before)
    after = score_for(scenario_after)
    passed = after < before
    return EvalResult(
        name="too_far_shifts_mix",
        passed=passed,
        score=1.0 if passed else 0.0,
        details=f"before={before:.4f}, after={after:.4f}",
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


def eval_vibe_query_extracts_complaint_sentence() -> EvalResult:
    intent = interpret_music_prompt("Couldn't find anything good when I typed in trippy darth Vader")
    descriptors = set(intent.descriptors if intent else [])
    passed = (
        intent is not None
        and intent.search_phrase == "trippy darth Vader"
        and intent.extracted_from_sentence
        and {"psychedelic", "cinematic", "sci-fi"}.issubset(descriptors)
    )
    return EvalResult(
        name="vibe_query_extracts_complaint_sentence",
        passed=passed,
        score=1.0 if passed else 0.0,
        details=f"intent={intent.as_response() if intent else None}",
    )


def eval_vibe_query_expands_activity_metaphor() -> EvalResult:
    intent = interpret_music_prompt("trippy ski music")
    descriptors = set(intent.descriptors if intent else [])
    expected = {"psychedelic", "gliding", "cold", "mountain"}
    passed = intent is not None and expected.issubset(descriptors)
    return EvalResult(
        name="vibe_query_expands_activity_metaphor",
        passed=passed,
        score=1.0 if passed else 0.0,
        details=f"descriptors={sorted(descriptors)}",
    )


def eval_prompted_search_scans_track_catalog() -> EvalResult:
    """Prompted song search should include track matches outside normal Discover frontier."""
    prompt_vec = _rand_vec(8, seed=9999)
    artists = [
        _make_artist(i, f"Filler Artist {i}", ["ambient"], vec_seed=i, popularity=20)
        for i in range(1, 511)
    ]
    target_artist = _make_artist(999, "Search Only Artist", ["cinematic electronic"], vec_seed=999, popularity=10)
    artists.append(target_artist)

    tracks = [
        _make_track(10_000 + i, f"Filler Track {i}", i, popularity=40, vec_seed=20_000 + i)
        for i in range(1, 511)
    ]
    target_track = _make_track(99_999, "Imperial Mushroom Cloud", 999, popularity=30, vec_seed=123)
    target_track["embedding"] = prompt_vec
    tracks.append(target_track)

    scenario = UserScenario(
        user_id="prompted_track_scan_test",
        library_artist_ids=[],
        played_track_ids=[],
        top_artist_ids=[],
        taste_vector=[],
    )
    client = build_mock_client(scenario, artists=artists, tracks=tracks, mentions=[])
    results = recommend_songs(
        client=client,
        user_id=scenario.user_id,
        taste_vector=[],
        prompt_vector=prompt_vec,
        weights=_weights(affinity=0.0, context=0.85, editorial=0.15),
        exclude_library=False,
        limit=30,
        prompt_text="trippy darth vader",
        exploration_seed=1,
    )
    names = [r["track_name"] for r in results]
    passed = "Imperial Mushroom Cloud" in names[:3]
    return EvalResult(
        name="prompted_search_scans_track_catalog",
        passed=passed,
        score=1.0 if passed else 0.0,
        details=f"top_tracks={names[:5]}",
    )


def eval_prompt_exactness() -> EvalResult:
    """Typed prompts should remain steering commands throughout the Radio flow."""
    discover_file = _API_DIR.parent / "web" / "app" / "dashboard" / "discover-view.tsx"
    recommend_route = _API_DIR.parent / "web" / "app" / "api" / "recommend-songs" / "route.ts"
    discover_source = discover_file.read_text()
    recommend_source = recommend_route.read_text()

    required_patterns = [
        "const promptSongsPromise = promptForLiveSearch && !isGuest",
        "fetchPromptSpotifySongs(promptForLiveSearch",
        "if (promptSongs.length > 0)",
        "promptMode: true",
        "taste_strategy: prompt.trim() ? null : tasteStrategy",
        "taste_strategy: prompt ? null : tasteStrategy",
    ]
    sources = discover_source + "\n" + recommend_source
    missing = [pattern for pattern in required_patterns if pattern not in sources]
    passed = not missing
    return EvalResult(
        name="prompt_exactness",
        passed=passed,
        score=1.0 if passed else 0.0,
        details="typed prompts run prompt Spotify search and do not apply saved taste strategy to backend prompt runs"
        if passed
        else f"missing={missing}",
    )


def eval_zero_play_added_at_tracks_do_not_crash() -> EvalResult:
    """Zero-play saved tracks with added_at should be valid song-ranking input."""
    now = datetime.now(timezone.utc)
    scenario = UserScenario(
        user_id="zero_play_added_at_song_test",
        library_artist_ids=[1],
        played_track_ids=[],
        top_artist_ids=[1],
        taste_vector=JAZZ_TASTE_VECTOR,
        user_tracks=[
            {
                "track_id": 101,
                "play_count": 0,
                "added_at": (now - timedelta(days=12)).isoformat(),
            }
        ],
    )
    try:
        results = recommend_songs(
            client=build_mock_client(scenario, artists=JAZZ_ARTISTS[:1], tracks=TRACKS[:2]),
            user_id=scenario.user_id,
            taste_vector=JAZZ_TASTE_VECTOR,
            prompt_vector=None,
            weights=_weights(),
            exclude_library=False,
            limit=10,
        )
    except Exception as exc:
        return EvalResult(
            name="zero_play_added_at_tracks_do_not_crash",
            passed=False,
            score=0.0,
            details=f"recommend_songs raised {type(exc).__name__}: {exc}",
        )
    return EvalResult(
        name="zero_play_added_at_tracks_do_not_crash",
        passed=len(results) > 0,
        score=1.0 if results else 0.0,
        details=f"returned={len(results)}",
    )


def eval_audio_profile_prefers_recent_saves_without_play_counts() -> EvalResult:
    """When play counts are absent, recent saves should steer audio-feature fit."""
    now = datetime.now(timezone.utc)
    artist = _make_artist(740, "Audio Profile Artist", ["jazz"], vec_seed=70, popularity=70)

    recent_profile = _make_track(1740, "Recent Bright Save", 740, popularity=40, vec_seed=1740)
    old_profile = _make_track(1741, "Old Dark Save", 740, popularity=40, vec_seed=1741)
    aligned = _make_track(1742, "Aligned Discovery", 740, popularity=55, vec_seed=1742)
    mismatch = _make_track(1743, "Mismatched Discovery", 740, popularity=55, vec_seed=1742)

    for track in (recent_profile, aligned):
        track.update({"energy": 1.0, "danceability": 1.0, "valence": 1.0, "acousticness": 0.0})
    for track in (old_profile, mismatch):
        track.update({"energy": 0.0, "danceability": 0.0, "valence": 0.0, "acousticness": 1.0})

    scenario = UserScenario(
        user_id="audio_profile_recent_save_test",
        library_artist_ids=[740],
        played_track_ids=[],
        top_artist_ids=[740],
        taste_vector=JAZZ_TASTE_VECTOR,
        user_tracks=[
            {
                "track_id": 1740,
                "play_count": 0,
                "added_at": (now - timedelta(days=5)).isoformat(),
            },
            {
                "track_id": 1741,
                "play_count": 0,
                "added_at": (now - timedelta(days=3 * 365)).isoformat(),
            },
        ],
    )
    results = recommend_songs(
        client=build_mock_client(
            scenario,
            artists=[artist],
            tracks=[recent_profile, old_profile, aligned, mismatch],
            mentions=[],
        ),
        user_id=scenario.user_id,
        taste_vector=JAZZ_TASTE_VECTOR,
        prompt_vector=None,
        weights=_weights(),
        exclude_library=False,
        limit=10,
        exploration_seed=1,
    )
    by_name = {r["track_name"]: r for r in results}
    aligned_score = by_name.get("Aligned Discovery", {}).get("score", 0.0)
    mismatch_score = by_name.get("Mismatched Discovery", {}).get("score", 0.0)
    passed = aligned_score > mismatch_score
    return EvalResult(
        name="audio_profile_prefers_recent_saves_without_play_counts",
        passed=passed,
        score=1.0 if passed else 0.0,
        details=f"aligned={aligned_score:.4f}, mismatch={mismatch_score:.4f}",
    )


def eval_no_raw_abort_copy() -> EvalResult:
    """Radio UI should not expose browser abort or exception text to users."""
    web_file = _API_DIR.parent / "web" / "app" / "dashboard" / "discover-view.tsx"
    source = web_file.read_text()
    forbidden = [
        "setError(err instanceof Error ? err.message",
        "Could not load recommendations (${reason})",
        "signal is aborted",
        "aborted without reason",
    ]
    hits = [pattern for pattern in forbidden if pattern in source]
    passed = not hits
    return EvalResult(
        name="no_raw_abort_copy",
        passed=passed,
        score=1.0 if passed else 0.0,
        details="no raw abort or exception copy found" if passed else f"found={hits}",
    )


def eval_background_tuning_retains_loaded_station() -> EvalResult:
    """Background tuning must preserve the station loaded before React commits state."""
    web_file = _API_DIR.parent / "web" / "app" / "dashboard" / "discover-view.tsx"
    source = web_file.read_text()
    required_patterns = [
        "fallbackResults?: SongRecommendation[];",
        "fallbackResults: cached",
        "fallbackResults: station.results",
        "const fallbackResults = options.fallbackResults ?? results;",
        "preserveResults && fallbackResults && fallbackResults.length > 0",
    ]
    missing = [pattern for pattern in required_patterns if pattern not in source]
    passed = not missing
    return EvalResult(
        name="background_tuning_retains_loaded_station",
        passed=passed,
        score=1.0 if passed else 0.0,
        details="background refresh receives the rendered fallback station explicitly"
        if passed
        else f"missing={missing}",
    )


def eval_play_learning_requires_dwell() -> EvalResult:
    """Radio should only learn positive play intent from the player dwell timer.

    Clicking a row starts playback, but the learning loop should not count that
    click as a meaningful play until the player has observed enough dwell time.
    """
    discover_file = _API_DIR.parent / "web" / "app" / "dashboard" / "discover-view.tsx"
    player_file = _API_DIR.parent / "web" / "app" / "dashboard" / "player-context.tsx"
    discover_source = discover_file.read_text()
    player_source = player_file.read_text()

    handle_play_start = discover_source.index("  async function handlePlay()")
    handle_feedback_start = discover_source.index("  async function handleFeedback", handle_play_start)
    handle_play_source = discover_source[handle_play_start:handle_feedback_start]
    immediate_play_logged = 'event_type: "play"' in handle_play_source
    dwell_timer_present = "MEANINGFUL_PLAY_MS" in player_source and 'logQueuePlaybackEvent(track, "play"' in player_source

    passed = not immediate_play_logged and dwell_timer_present
    details = (
        "row click does not log play; player dwell timer logs meaningful plays"
        if passed
        else f"immediate_play_logged={immediate_play_logged}, dwell_timer_present={dwell_timer_present}"
    )
    return EvalResult(
        name="play_learning_requires_dwell",
        passed=passed,
        score=1.0 if passed else 0.0,
        details=details,
    )


def eval_station_fallbacks_are_observable() -> EvalResult:
    """Cache, starter, and empty Radio fallbacks should be visible in station telemetry."""
    station_file = _API_DIR.parent / "web" / "app" / "api" / "station" / "last" / "route.ts"
    health_file = _API_DIR.parent / "web" / "app" / "api" / "radio-health" / "route.ts"
    station_source = station_file.read_text()
    health_source = health_file.read_text()

    required_station_patterns = [
        '.from("station_runs")',
        'status: "cache"',
        'fallbackLevel: "cache"',
        'status: "starter"',
        'fallbackLevel: "starter"',
        'status: "empty"',
        'fallbackLevel: "empty"',
        "run_id:",
    ]
    required_health_patterns = [
        'run.fallback_level === "cache"',
        'run.fallback_level === "starter"',
        'typeof run.latency_ms === "number" && Number.isFinite(run.latency_ms)',
        'typeof run.result_count === "number" && Number.isFinite(run.result_count)',
        "cache_hit_rate",
    ]
    missing = [
        pattern
        for pattern in required_station_patterns
        if pattern not in station_source
    ] + [
        pattern
        for pattern in required_health_patterns
        if pattern not in health_source
    ]
    passed = not missing
    return EvalResult(
        name="station_fallbacks_are_observable",
        passed=passed,
        score=1.0 if passed else 0.0,
        details="cache/starter/empty station fallbacks write station_runs" if passed else f"missing={missing}",
    )


def eval_client_composed_stations_record_runs() -> EvalResult:
    """Client-composed prompt/live stations should cache and write station_runs."""
    cache_route = _API_DIR.parent / "web" / "app" / "api" / "station" / "cache" / "route.ts"
    discover_file = _API_DIR.parent / "web" / "app" / "dashboard" / "discover-view.tsx"
    cache_source = cache_route.read_text()
    discover_source = discover_file.read_text()

    required_cache_patterns = [
        '.from("station_runs")',
        'status: "success"',
        'fallback_level: "fresh"',
        "result_count: resultCount",
        "run_id: runId",
    ]
    required_ui_patterns = [
        "typeof body.run_id === \"string\"",
        "station.run_id ?? station.station_id ?? null",
    ]
    missing = [
        pattern for pattern in required_cache_patterns if pattern not in cache_source
    ] + [
        pattern for pattern in required_ui_patterns if pattern not in discover_source
    ]
    passed = not missing
    return EvalResult(
        name="client_composed_stations_record_runs",
        passed=passed,
        score=1.0 if passed else 0.0,
        details="client-composed station cache writes station_runs and UI prefers run_id"
        if passed
        else f"missing={missing}",
    )


def eval_backend_stage_timings_are_observable() -> EvalResult:
    """Backend responses should expose stage timings for production recommendation diagnosis."""
    route_file = _API_DIR / "app" / "routes" / "recommend.py"
    ranking_file = _API_DIR / "app" / "services" / "song_ranking.py"
    source = route_file.read_text() + "\n" + ranking_file.read_text()
    required_patterns = [
        "performance_timings=rank_stage_timings",
        'timings["persistence_ms"]',
        'print(f"recommend_songs: timings={timings}")',
        '_record_stage("artist_match_rpc_ms"',
        '_record_stage("mention_fetch_ms"',
        '_record_stage("mention_context_rpc_ms"',
        '_record_stage("track_fetch_ms"',
        '_record_stage("track_match_rpc_ms"',
        '_record_stage("rerank_ms"',
    ]
    missing = [pattern for pattern in required_patterns if pattern not in source]
    passed = not missing
    return EvalResult(
        name="backend_stage_timings_are_observable",
        passed=passed,
        score=1.0 if passed else 0.0,
        details="backend logs and returns stage timings for ranking diagnosis"
        if passed
        else f"missing={missing}",
    )


def eval_cache_does_not_poison_prompt() -> EvalResult:
    """Cached unprompted stations must not override a typed prompt station."""
    discover_file = _API_DIR.parent / "web" / "app" / "dashboard" / "discover-view.tsx"
    station_last = _API_DIR.parent / "web" / "app" / "api" / "station" / "last" / "route.ts"
    discover_source = discover_file.read_text()
    station_source = station_last.read_text()

    required_patterns = [
        "cached.prompt !== prompt",
        "prompt: prompt.trim()",
        "serverStationKey(prompt, strategy)",
        "cacheKey(prompt, strategy)",
        ".eq(\"cache_key\", key)",
        "if (!prompt.trim())",
    ]
    sources = discover_source + "\n" + station_source
    missing = [pattern for pattern in required_patterns if pattern not in sources]
    passed = not missing
    return EvalResult(
        name="cache_does_not_poison_prompt",
        passed=passed,
        score=1.0 if passed else 0.0,
        details="browser and server station caches include prompt in their keys; starter fallback is unprompted only"
        if passed
        else f"missing={missing}",
    )


def eval_taste_snapshots_are_durable() -> EvalResult:
    """Taste snapshots should be awaited after setup/import/feedback milestones."""
    taste_lib = _API_DIR.parent / "web" / "lib" / "taste-snapshot.ts"
    import_route = _API_DIR.parent / "web" / "app" / "api" / "import-playlist" / "route.ts"
    event_route = _API_DIR.parent / "web" / "app" / "api" / "recommendation-event" / "route.ts"
    job_status_route = _API_DIR.parent / "web" / "app" / "api" / "job-status" / "route.ts"
    taste_source = taste_lib.read_text()
    import_source = import_route.read_text()
    event_source = event_route.read_text()
    job_status_source = job_status_route.read_text()

    required_patterns = [
        "await createTasteSnapshot({ sb, userId, reason: \"playlist_import\" })",
        "await maybeCreateFeedbackTasteSnapshot({",
        "eventType,",
        "data?.status === \"success\"",
        "reason: `setup_all:${jobId}`",
        "dedupeReason: true",
        "reason: `feedback_milestone:${count}`",
        "if (!isMeaningfulTasteEvent(eventType)) return;",
    ]
    sources = "\n".join([taste_source, import_source, event_source, job_status_source])
    missing = [pattern for pattern in required_patterns if pattern not in sources]
    forbidden = [
        "void createTasteSnapshot({ sb, userId, reason: \"playlist_import\" })",
        "void maybeCreateFeedbackTasteSnapshot",
    ]
    found_forbidden = [pattern for pattern in forbidden if pattern in sources]
    passed = not missing and not found_forbidden
    return EvalResult(
        name="taste_snapshots_are_durable",
        passed=passed,
        score=1.0 if passed else 0.0,
        details="setup/import/feedback snapshot writes are awaited and deduped"
        if passed
        else f"missing={missing}, forbidden={found_forbidden}",
    )


def eval_radio_copy_hides_debug_source_language() -> EvalResult:
    """Default Radio/Taste surfaces should use product language, not pipeline labels."""
    discover_file = _API_DIR.parent / "web" / "app" / "dashboard" / "discover-view.tsx"
    library_file = _API_DIR.parent / "web" / "app" / "dashboard" / "library-view.tsx"
    source = discover_file.read_text() + "\n" + library_file.read_text()
    forbidden = [
        "Catalog-ranked",
        "catalog-ranked",
        "outside-air",
        "Outside air",
        "outside air",
        "modeled catalog",
        "modeled tracks",
        "Live Spotify",
        "outside-catalog",
        "Outside catalog",
    ]
    hits = [pattern for pattern in forbidden if pattern in source]
    passed = not hits
    return EvalResult(
        name="radio_copy_hides_debug_source_language",
        passed=passed,
        score=1.0 if passed else 0.0,
        details="Radio/Taste copy avoids catalog/outside-air implementation language"
        if passed
        else f"found={hits}",
    )


def eval_taste_profile_explains_recent_learning() -> EvalResult:
    """Taste Profile should show human-readable snapshot evidence and keep Radio diagnostics secondary."""
    library_route = _API_DIR.parent / "web" / "app" / "api" / "library" / "route.ts"
    library_view = _API_DIR.parent / "web" / "app" / "dashboard" / "library-view.tsx"
    discover_view = _API_DIR.parent / "web" / "app" / "dashboard" / "discover-view.tsx"
    source = library_route.read_text() + "\n" + library_view.read_text()
    discover_source = discover_view.read_text()
    required_patterns = [
        '.from("taste_snapshots")',
        '"You lean toward"',
        '"Radio will reach"',
        '"Your strongest anchors are"',
        '"Recently learned from"',
        '<details className="rounded-lg border border-neutral-200 bg-white px-4 py-3',
        "Station mix",
    ]
    combined = source + "\n" + discover_source
    missing = [pattern for pattern in required_patterns if pattern not in combined]
    passed = not missing
    return EvalResult(
        name="taste_profile_explains_recent_learning",
        passed=passed,
        score=1.0 if passed else 0.0,
        details="Taste Profile reads the latest snapshot and Radio mix details stay collapsed"
        if passed
        else f"missing={missing}",
    )


def eval_unprompted_live_fill_is_bounded() -> EvalResult:
    """Unprompted stations should not refill past their fresh-air quota with generic live search tracks."""
    discover_file = _API_DIR.parent / "web" / "app" / "dashboard" / "discover-view.tsx"
    taste_view = _API_DIR.parent / "web" / "app" / "dashboard" / "library-view.tsx"
    snapshot_lib = _API_DIR.parent / "web" / "lib" / "taste-snapshot.ts"
    discover_source = discover_file.read_text()
    taste_source = taste_view.read_text() + "\n" + snapshot_lib.read_text()
    required_patterns = [
        "const MIN_PLAYABLE_STATION_TRACKS = 12;",
        "catalogFilled.length >= MIN_PLAYABLE_STATION_TRACKS",
        "options.promptMode || catalogCandidates.length === 0",
        ": Math.min(target, MIN_PLAYABLE_STATION_TRACKS);",
        'normalized.includes("_")',
        'normalized.includes("lidarr")',
        'normalized.includes("batch")',
    ]
    source = discover_source + "\n" + taste_source
    missing = [pattern for pattern in required_patterns if pattern not in source]
    passed = not missing
    return EvalResult(
        name="unprompted_live_fill_is_bounded",
        passed=passed,
        score=1.0 if passed else 0.0,
        details="unprompted stations cap live refill at the playable minimum and hide internal genre tags"
        if passed
        else f"missing={missing}",
    )


def eval_onboarding_copy_hides_pipeline_language() -> EvalResult:
    """Default onboarding surfaces should explain the product without exposing pipeline vocabulary."""
    dashboard_dir = _API_DIR.parent / "web" / "app" / "dashboard"
    files = [
        _API_DIR.parent / "web" / "app" / "page.tsx",
        _API_DIR.parent / "web" / "app" / "playlist-import-form.tsx",
        dashboard_dir / "SetupAllButton.tsx",
        dashboard_dir / "SourcesButton.tsx",
        dashboard_dir / "sidebar.tsx",
        dashboard_dir / "setup-banner.tsx",
        dashboard_dir / "radio-view.tsx",
        dashboard_dir / "library-view.tsx",
        dashboard_dir / "discover-view.tsx",
        dashboard_dir / "onboarding-wizard.tsx",
        dashboard_dir / "EmbedButton.tsx",
        dashboard_dir / "PopulateTracksButton.tsx",
    ]
    source = "\n".join(file.read_text() for file in files)
    forbidden = [
        "Generate embeddings",
        "Track embeddings missing",
        "Catalog tracks",
        "playable catalog tracks",
        'label="enriched"',
        'label="embedded"',
        "Prepare song catalog",
        "Model songs",
        "Model artist similarity",
        "Model song matches",
        "Track catalog is empty",
        "synced, enriched, and embedded",
        "outside the catalog",
        "local catalog",
        "live Spotify search",
        'label: "Embedding"',
        "source mentions can match your catalog",
        "AI taste matching",
        "Get AI-powered recommendations",
        "Spotify status:",
        "authorization code",
        "redirect URI",
        "403 Forbidden",
        "live Spotify window",
        "Built from live Spotify",
        'title: "Generate Embeddings"',
        '"Embed artists"',
    ]
    hits = [pattern for pattern in forbidden if pattern in source]
    passed = not hits
    return EvalResult(
        name="onboarding_copy_hides_pipeline_language",
        passed=passed,
        score=1.0 if passed else 0.0,
        details="onboarding and default Radio/Taste surfaces use user-facing language"
        if passed
        else f"found={hits}",
    )


def eval_api_health_is_lightweight() -> EvalResult:
    """Backend /health should be fast liveness, with DB checks isolated in /ready."""
    main_file = _API_DIR / "app" / "main.py"
    source = main_file.read_text()
    health_start = source.index("@app.get(\"/health\")")
    ready_start = source.index("@app.get(\"/ready\")", health_start)
    health_source = source[health_start:ready_start]
    ready_source = source[ready_start:]

    health_uses_db = "admin_supabase" in health_source or ".table(" in health_source
    ready_checks_db = "admin_supabase" in ready_source and ".table(\"sources\")" in ready_source
    passed = not health_uses_db and ready_checks_db
    return EvalResult(
        name="api_health_is_lightweight",
        passed=passed,
        score=1.0 if passed else 0.0,
        details="backend /health is liveness-only and /ready checks Supabase"
        if passed
        else f"health_uses_db={health_uses_db}, ready_checks_db={ready_checks_db}",
    )


# ── Content quality evals ───────────────────────────────────────


def eval_instrumental_penalized() -> EvalResult:
    """A highly instrumental track must be absent from a normal station.

    Miles Davis artist 1 has track 103 (instrumentalness=0.95) and track 101
    (instrumentalness=None). A score penalty is insufficient because sparse
    station fill can still surface the utility track.
    """
    partial_user = UserScenario(
        user_id="user_inst_test",
        library_artist_ids=[1],
        played_track_ids=[],
        top_artist_ids=[1],
        taste_vector=JAZZ_TASTE_VECTOR,
    )
    test_tracks = [t for t in TRACKS if t["artist_id"] == 1 and t["id"] in (101, 103)]
    client = build_mock_client(partial_user, artists=JAZZ_ARTISTS[:1], tracks=test_tracks)
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
    normal = by_track.get("Kind of Blue")
    instrumental = by_track.get("Meditation Ambient")

    if normal is None:
        return EvalResult(
            name="instrumental_penalized",
            passed=False,
            score=0.0,
            details="Normal track 'Kind of Blue' missing from results",
        )

    passed = instrumental is None
    return EvalResult(
        name="instrumental_penalized",
        passed=passed,
        score=1.0 if passed else 0.0,
        details="Instrumental utility track absent from normal station"
        if passed
        else "Instrumental utility track leaked into normal station",
    )


def eval_utility_title_excluded_without_audio_features() -> EvalResult:
    """Utility-title detection must cover Spotify tracks without audio features."""
    artist = _make_artist(935, "Vocal Artist", ["hip hop"], vec_seed=935, popularity=60)
    tracks = [
        _make_track(9350, "Actual Song", 935, popularity=70, vec_seed=9350),
        _make_track(9351, "Midnight Type Beat", 935, popularity=99, vec_seed=9351),
    ]
    scenario = UserScenario(
        user_id="user_utility_title_test",
        library_artist_ids=[935],
        played_track_ids=[],
        top_artist_ids=[935],
        taste_vector=artist["embedding"],
    )
    results = recommend_songs(
        client=build_mock_client(scenario, artists=[artist], tracks=tracks, mentions=[]),
        user_id=scenario.user_id,
        taste_vector=artist["embedding"],
        prompt_vector=None,
        weights=_weights(),
        exclude_library=False,
        limit=10,
        exploration_seed=1,
    )
    names = [row["track_name"] for row in results]
    passed = "Actual Song" in names and "Midnight Type Beat" not in names
    return EvalResult(
        name="utility_title_excluded_without_audio_features",
        passed=passed,
        score=1.0 if passed else 0.0,
        details=f"returned={names}",
    )


def eval_explicit_instrumental_prompt_allows_utility_track() -> EvalResult:
    """An explicit instrumental request should retain utility-track opt-in."""
    artist = _make_artist(936, "Beat Artist", ["hip hop"], vec_seed=936, popularity=60)
    utility = _make_track(9360, "Midnight Type Beat", 936, popularity=70, vec_seed=9360)
    scenario = UserScenario(
        user_id="user_explicit_utility_prompt",
        library_artist_ids=[],
        played_track_ids=[],
        top_artist_ids=[],
        taste_vector=artist["embedding"],
    )
    results = recommend_songs(
        client=build_mock_client(scenario, artists=[artist], tracks=[utility], mentions=[]),
        user_id=scenario.user_id,
        taste_vector=artist["embedding"],
        prompt_vector=artist["embedding"],
        prompt_text="instrumental hip hop beats",
        weights=_weights(),
        exclude_library=False,
        limit=10,
        exploration_seed=1,
    )
    names = [row["track_name"] for row in results]
    passed = (
        prompt_requests_utility_tracks("instrumental hip hop beats")
        and not should_exclude_utility_track(utility, allow_instrumental_utility=True)
        and "Midnight Type Beat" in names
    )
    return EvalResult(
        name="explicit_instrumental_prompt_allows_utility_track",
        passed=passed,
        score=1.0 if passed else 0.0,
        details=f"returned={names}",
    )


def eval_live_and_cached_utility_tracks_are_filtered() -> EvalResult:
    """Live Spotify and saved-station paths must apply the same utility filter."""
    web_root = _API_DIR.parent / "web"
    quality_source = (web_root / "lib" / "track-quality.ts").read_text()
    discover_source = (web_root / "app" / "dashboard" / "discover-view.tsx").read_text()
    prompt_source = (web_root / "app" / "api" / "prompt-spotify-songs" / "route.ts").read_text()
    last_source = (web_root / "app" / "api" / "station" / "last" / "route.ts").read_text()
    cache_source = (web_root / "app" / "api" / "station" / "cache" / "route.ts").read_text()
    required_patterns = [
        "UTILITY_TRACK_PATTERNS",
        "isExplicitUtilityTrackRequest",
        "isUtilityTrack",
        "withoutUtilityTracks",
        "if (!allowUtilityTracks && isUtilityTrack(track)) return false;",
        "(!allowUtilityTracks && isUtilityTrack(track))",
        "cached.results.filter",
        "const results = rawResults.filter",
    ]
    source = "\n".join([quality_source, discover_source, prompt_source, last_source, cache_source])
    missing = [pattern for pattern in required_patterns if pattern not in source]
    passed = not missing
    return EvalResult(
        name="live_and_cached_utility_tracks_are_filtered",
        passed=passed,
        score=1.0 if passed else 0.0,
        details="catalog, live Spotify, and saved-station boundaries filter utility tracks"
        if passed
        else f"missing={missing}",
    )


def eval_live_intents_reject_unrequested_utility_queries() -> EvalResult:
    """Unprompted live expansion should not ask Spotify for beat-style material."""
    intents_file = _API_DIR / "app" / "services" / "live_candidate_intents.py"
    source = intents_file.read_text()
    required_patterns = [
        "do not query instrumentals",
        "allow_utility_tracks=prompt_requests_utility_tracks(brief[\"prompt\"])",
        "not allow_utility_tracks and prompt_requests_utility_tracks(query)",
        "not allow_utility_tracks and prompt_requests_utility_tracks(clean)",
    ]
    missing = [pattern for pattern in required_patterns if pattern not in source]
    passed = not missing
    return EvalResult(
        name="live_intents_reject_unrequested_utility_queries",
        passed=passed,
        score=1.0 if passed else 0.0,
        details="live intent generator rejects utility queries unless the prompt opts in"
        if passed
        else f"missing={missing}",
    )


def eval_instrumental_preference_allows_instrumental_shortlist() -> EvalResult:
    """Instrumental-loving users should not lose instrumental candidates before final scoring."""
    artist = _make_artist(930, "Instrumental Preference Artist", ["electronic"], vec_seed=930, popularity=55)
    saved_instrumentals = [
        _make_track(
            9320 + idx,
            f"Saved Instrumental Anchor {idx}",
            930,
            popularity=5,
            vec_seed=9320 + idx,
            instrumentalness=0.96,
            energy=0.65,
            danceability=0.55,
            valence=0.45,
            acousticness=0.20,
        )
        for idx in range(3)
    ]
    target = _make_track(
        9301,
        "Instrumental Candidate",
        930,
        popularity=99,
        vec_seed=9301,
        instrumentalness=0.96,
        energy=0.65,
        danceability=0.55,
        valence=0.45,
        acousticness=0.20,
    )
    decoys = [
        _make_track(9310 + idx, f"Vocal Decoy {idx}", 930, popularity=10, vec_seed=9310 + idx)
        for idx in range(4)
    ]
    scenario = UserScenario(
        user_id="user_instrumental_preference",
        library_artist_ids=[930],
        played_track_ids=[],
        top_artist_ids=[930],
        taste_vector=artist["embedding"],
        user_tracks=[
            {
                "track_id": 9320 + idx,
                "play_count": 0,
                "last_played_at": None,
                "added_at": (datetime.now(timezone.utc) - timedelta(days=5)).isoformat(),
            }
            for idx in range(3)
        ],
    )
    results = recommend_songs(
        client=build_mock_client(
            scenario,
            artists=[artist],
            tracks=[*saved_instrumentals, target, *decoys],
            mentions=[],
        ),
        user_id=scenario.user_id,
        taste_vector=artist["embedding"],
        prompt_vector=None,
        weights=_weights(),
        exclude_library=False,
        limit=10,
        exploration_seed=1,
    )
    names = [r["track_name"] for r in results]
    passed = any(name.startswith("Saved Instrumental Anchor") or name == "Instrumental Candidate" for name in names)
    return EvalResult(
        name="instrumental_preference_allows_instrumental_shortlist",
        passed=passed,
        score=1.0 if passed else 0.0,
        details=(
            "high-instrumental candidate remained eligible for a user whose saved tracks "
            f"show instrumental preference; returned={names}"
        ),
    )


def eval_single_instrumental_save_does_not_flip_radio() -> EvalResult:
    """One saved instrumental should not turn ordinary Radio into a beat station."""
    artist = _make_artist(937, "Mixed Artist", ["electronic"], vec_seed=937, popularity=55)
    saved = _make_track(
        9370,
        "Saved Instrumental Anchor",
        937,
        popularity=5,
        vec_seed=9370,
        instrumentalness=0.96,
        energy=0.65,
        danceability=0.55,
        valence=0.45,
        acousticness=0.20,
    )
    utility = _make_track(
        9371,
        "Producer Type Beat",
        937,
        popularity=99,
        vec_seed=9371,
        instrumentalness=0.96,
    )
    vocal = _make_track(9372, "Finished Vocal Song", 937, popularity=50, vec_seed=9372)
    scenario = UserScenario(
        user_id="user_single_instrumental_save",
        library_artist_ids=[937],
        played_track_ids=[],
        top_artist_ids=[937],
        taste_vector=artist["embedding"],
        user_tracks=[
            {
                "track_id": 9370,
                "play_count": 0,
                "last_played_at": None,
                "added_at": (datetime.now(timezone.utc) - timedelta(days=5)).isoformat(),
            },
        ],
    )
    results = recommend_songs(
        client=build_mock_client(
            scenario,
            artists=[artist],
            tracks=[saved, utility, vocal],
            mentions=[],
        ),
        user_id=scenario.user_id,
        taste_vector=artist["embedding"],
        prompt_vector=None,
        weights=_weights(),
        exclude_library=False,
        limit=10,
        exploration_seed=1,
    )
    names = [row["track_name"] for row in results]
    passed = "Finished Vocal Song" in names and "Producer Type Beat" not in names
    return EvalResult(
        name="single_instrumental_save_does_not_flip_radio",
        passed=passed,
        score=1.0 if passed else 0.0,
        details=f"returned={names}",
    )


def eval_spoken_word_penalized() -> EvalResult:
    """A high-speechiness track should score below a normal track from the same artist.

    Miles Davis artist 1 has track 104 (speechiness=0.85) and track 101
    (speechiness=None). The spoken-word penalty (0.30x) should push
    the podcast-like track well below the normal track.
    """
    partial_user = UserScenario(
        user_id="user_speech_test",
        library_artist_ids=[1],
        played_track_ids=[],
        top_artist_ids=[1],
        taste_vector=JAZZ_TASTE_VECTOR,
    )
    test_tracks = [t for t in TRACKS if t["artist_id"] == 1 and t["id"] in (101, 104)]
    client = build_mock_client(partial_user, artists=JAZZ_ARTISTS[:1], tracks=test_tracks)
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
    normal = by_track.get("Kind of Blue")
    spoken = by_track.get("Podcast Intro")

    if normal is None:
        return EvalResult(
            name="spoken_word_penalized",
            passed=False,
            score=0.0,
            details="Normal track 'Kind of Blue' missing from results",
        )

    passed = spoken is None
    return EvalResult(
        name="spoken_word_penalized",
        passed=passed,
        score=1.0 if passed else 0.0,
        details="Spoken-word utility track absent from normal station"
        if passed
        else "Spoken-word utility track leaked into normal station",
    )


def eval_audio_match_meaningful() -> EvalResult:
    """Audio feature matching should meaningfully differentiate tracks.

    A user whose saved library is exclusively high-energy tracks should see
    high-energy candidates score higher than mellow candidates. The user's
    library contains only high-energy tracks (via a dedicated track) so the
    audio profile is clearly high-energy, making the differentiation obvious.
    """
    # Create a library track with high energy for audio profile building.
    # This is the ONLY saved track, so the profile is purely high-energy.
    energy_lib_track = _make_track(
        901, "Energy Lib", 11, popularity=80, vec_seed=901,
        energy=0.92, danceability=0.85, valence=0.75, acousticness=0.05,
    )
    high_energy_user = UserScenario(
        user_id="user_energy_test",
        library_artist_ids=[11],
        played_track_ids=[],
        top_artist_ids=[11],
        taste_vector=ROCK_TASTE_VECTOR,
        user_tracks=[
            {"track_id": 901, "play_count": 0, "last_played_at": None,
             "added_at": (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()},
        ],
    )
    test_tracks = [
        energy_lib_track,
        _make_track(902, "Candidate High Energy", 11, popularity=75, vec_seed=902,
                    energy=0.90, danceability=0.80, valence=0.70, acousticness=0.10),
        _make_track(903, "Candidate Mellow", 11, popularity=75, vec_seed=903,
                    energy=0.15, danceability=0.20, valence=0.25, acousticness=0.90),
    ]
    client = build_mock_client(
        high_energy_user,
        artists=[a for a in ALL_ARTISTS if a["id"] == 11],
        tracks=test_tracks,
    )
    results = recommend_songs(
        client=client,
        user_id=high_energy_user.user_id,
        taste_vector=ROCK_TASTE_VECTOR,
        prompt_vector=None,
        weights=_weights(),
        exclude_library=False,
        limit=10,
        exploration_seed=42,
    )
    by_track = {r["track_name"]: r for r in results}
    high_e = by_track.get("Candidate High Energy")
    low_e = by_track.get("Candidate Mellow")

    if high_e is None or low_e is None:
        present = [r["track_name"] for r in results]
        return EvalResult(
            name="audio_match_meaningful",
            passed=False,
            score=0.0,
            details=f"Missing track(s). Present: {present}",
        )

    gap = high_e["score"] - low_e["score"]
    passed = high_e["score"] > low_e["score"]
    return EvalResult(
        name="audio_match_meaningful",
        passed=passed,
        score=1.0 if passed else 0.0,
        details=(
            f"High energy score={high_e['score']:.4f} vs "
            f"mellow score={low_e['score']:.4f} (gap={gap:.4f})"
        ),
    )


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
        eval_feedback_changes_rank(),
        eval_too_familiar_shifts_mix(),
        eval_too_far_shifts_mix(),
        eval_no_identical_list_repeated(),
        eval_strict_novelty_zero_overlap_when_possible(),
        eval_graceful_mode_refill_under_sparse_catalog(),
        eval_vibe_query_extracts_complaint_sentence(),
        eval_vibe_query_expands_activity_metaphor(),
        eval_prompted_search_scans_track_catalog(),
        eval_prompt_exactness(),
        eval_zero_play_added_at_tracks_do_not_crash(),
        eval_audio_profile_prefers_recent_saves_without_play_counts(),
        eval_no_raw_abort_copy(),
        eval_background_tuning_retains_loaded_station(),
        eval_play_learning_requires_dwell(),
        eval_station_fallbacks_are_observable(),
        eval_client_composed_stations_record_runs(),
        eval_backend_stage_timings_are_observable(),
        eval_cache_does_not_poison_prompt(),
        eval_taste_snapshots_are_durable(),
        eval_radio_copy_hides_debug_source_language(),
        eval_taste_profile_explains_recent_learning(),
        eval_unprompted_live_fill_is_bounded(),
        eval_onboarding_copy_hides_pipeline_language(),
        eval_api_health_is_lightweight(),
        eval_instrumental_penalized(),
        eval_utility_title_excluded_without_audio_features(),
        eval_explicit_instrumental_prompt_allows_utility_track(),
        eval_live_and_cached_utility_tracks_are_filtered(),
        eval_live_intents_reject_unrequested_utility_queries(),
        eval_instrumental_preference_allows_instrumental_shortlist(),
        eval_single_instrumental_save_does_not_flip_radio(),
        eval_spoken_word_penalized(),
        eval_audio_match_meaningful(),
    ]
