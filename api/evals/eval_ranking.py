"""Evals for the artist-level ranking algorithm (ranking.py).

Each eval function returns an EvalResult — a named tuple of:
  name       unique identifier used in reports
  passed     bool: did this eval meet its success criterion?
  score      float 0–1: quantitative quality measure
  details    human-readable explanation of what was measured
  threshold  the minimum score required to pass (informational)

Evals run entirely in-process against MockSupabaseClient — no DB needed.
"""
from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

# Make `app` importable when running from the api/ directory or repo root.
_API_DIR = Path(__file__).parent.parent
if str(_API_DIR) not in sys.path:
    sys.path.insert(0, str(_API_DIR))

from app.services.ranking import _diversity_rerank, _percentile_rank, rank_candidates
from evals.fixtures import (
    ALL_ARTISTS,
    ELEC_ARTISTS,
    JAZZ_ARTISTS,
    JAZZ_TASTE_VECTOR,
    JAZZ_USER,
    RECENT_MENTIONS,
    ROCK_ARTISTS,
    ROCK_TASTE_VECTOR,
    ROCK_USER,
    SOURCES,
    STALE_MENTIONS,
    TRACKS,
    UserScenario,
    _make_artist,
    _make_mention,
    _rand_vec,
    build_mock_client,
)
from evals.metrics import max_genre_fraction, ndcg_at_k, novelty_rate


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


def eval_taste_alignment() -> EvalResult:
    """A jazz-fan user should have mostly jazz artists in their top 5 results.

    Checks that the affinity signal (taste vector similarity) surfaces
    genre-aligned artists above unrelated ones.
    """
    client = build_mock_client(JAZZ_USER)
    results = rank_candidates(
        client=client,
        user_id=JAZZ_USER.user_id,
        taste_vector=JAZZ_TASTE_VECTOR,
        prompt_vector=None,
        weights=_weights(),
        exclude_library=False,
        limit=10,
    )
    jazz_ids = {a["id"] for a in JAZZ_ARTISTS}
    top5_ids = {int(r["artist_id"]) for r in results[:5]}
    jazz_in_top5 = len(top5_ids & jazz_ids)
    score = jazz_in_top5 / 5.0
    return EvalResult(
        name="taste_alignment",
        passed=jazz_in_top5 >= 3,
        score=score,
        details=f"Jazz artists in top 5: {jazz_in_top5}/5. IDs found: {sorted(top5_ids)}",
        threshold=0.6,
    )


def eval_library_penalty() -> EvalResult:
    """A non-library artist with identical affinity should rank above a library one.

    Validates the 20% score reduction applied to library artists so that
    Discover stays fresh rather than just re-surfacing the user's saved music.
    """
    # Both artists share vec_seed=1 → same embedding → same raw affinity
    library_a = _make_artist(500, "Library Artist", ["jazz"], vec_seed=1, popularity=70)
    new_a = _make_artist(501, "New Artist", ["jazz"], vec_seed=1, popularity=70)

    scenario = UserScenario(
        user_id="lib_test",
        library_artist_ids=[500],
        played_track_ids=[],
        top_artist_ids=[500],
        taste_vector=JAZZ_TASTE_VECTOR,
    )
    client = build_mock_client(scenario, artists=[library_a, new_a], tracks=[], mentions=[])
    results = rank_candidates(
        client=client,
        user_id=scenario.user_id,
        taste_vector=JAZZ_TASTE_VECTOR,
        prompt_vector=None,
        weights=_weights(),
        exclude_library=False,
        limit=5,
    )
    ids = [int(r["artist_id"]) for r in results]
    lib_rank = ids.index(500) if 500 in ids else 999
    new_rank = ids.index(501) if 501 in ids else 999
    passed = new_rank < lib_rank
    return EvalResult(
        name="library_penalty",
        passed=passed,
        score=1.0 if passed else 0.0,
        details=f"New artist rank {new_rank} vs library artist rank {lib_rank} (lower = better)",
    )


def eval_previously_recommended_penalty() -> EvalResult:
    """An artist already in a saved playlist should rank below a library-only one.

    The 40% penalty on previously-recommended artists stacks on top of the
    20% library penalty, pushing these artists to the bottom so Discover
    doesn't keep showing the same recommendations.
    """
    playlist_a = _make_artist(600, "Playlist Artist", ["jazz"], vec_seed=3, popularity=70)
    library_only = _make_artist(601, "Library-Only Artist", ["jazz"], vec_seed=3, popularity=70)

    scenario = UserScenario(
        user_id="prev_rec_test",
        library_artist_ids=[600, 601],
        played_track_ids=[],
        top_artist_ids=[600, 601],
        taste_vector=JAZZ_TASTE_VECTOR,
        playlist_artist_ids=[600],  # artist 600 also lives in a saved playlist
    )
    client = build_mock_client(scenario, artists=[playlist_a, library_only], tracks=[], mentions=[])
    results = rank_candidates(
        client=client,
        user_id=scenario.user_id,
        taste_vector=JAZZ_TASTE_VECTOR,
        prompt_vector=None,
        weights=_weights(),
        exclude_library=False,
        limit=5,
    )
    ids = [int(r["artist_id"]) for r in results]
    playlist_rank = ids.index(600) if 600 in ids else 999
    library_rank = ids.index(601) if 601 in ids else 999
    passed = library_rank < playlist_rank
    return EvalResult(
        name="previously_recommended_penalty",
        passed=passed,
        score=1.0 if passed else 0.0,
        details=f"Library-only rank {library_rank} vs playlist rank {playlist_rank}",
    )


def eval_genre_diversity_cap() -> EvalResult:
    """When one genre scores slightly higher, _diversity_rerank should cap it at ≤40% of results.

    The 30% threshold triggers a 0.7× penalty (soft cap, not a hard cutoff).
    We test _diversity_rerank directly with crafted scores so the result is
    deterministic and doesn't depend on embedding geometry. Scores are set
    close enough (jazz 0.72→0.70, rock 0.67→0.65) that the penalty can flip
    selections — the realistic scenario where diversity enforcement matters.
    """
    pool = []
    for i, a in enumerate(JAZZ_ARTISTS):
        pool.append({
            "artist_id": str(a["id"]),
            "score": 0.720 - i * 0.005,
            "genres": a["genres"],
            "name": a["name"],
        })
    for i, a in enumerate(ROCK_ARTISTS):
        pool.append({
            "artist_id": str(a["id"]),
            "score": 0.670 - i * 0.005,
            "genres": a["genres"],
            "name": a["name"],
        })
    for i, a in enumerate(ELEC_ARTISTS):
        pool.append({
            "artist_id": str(a["id"]),
            "score": 0.620 - i * 0.005,
            "genres": a["genres"],
            "name": a["name"],
        })
    pool.sort(key=lambda r: r["score"], reverse=True)

    result = _diversity_rerank(pool, 10, library_artist_ids=set())
    frac = max_genre_fraction(result) if result else 0.0
    passed = frac <= 0.40
    score = max(0.0, 1.0 - max(0.0, frac - 0.3) / 0.3) if frac > 0.3 else 1.0
    genre_breakdown: dict = {}
    for r in result:
        g = (r.get("genres") or ["?"])[0]
        genre_breakdown[g] = genre_breakdown.get(g, 0) + 1
    return EvalResult(
        name="genre_diversity_cap",
        passed=passed,
        score=round(score, 4),
        details=f"Max genre fraction: {frac:.1%}. Breakdown: {genre_breakdown}",
        threshold=0.7,
    )


def eval_scores_non_negative() -> EvalResult:
    """All returned scores must be ≥ 0 even with the exploration factor applied.

    The exploration nudge is ±8%, so a low-base score that receives -8%
    should be clamped by max(0.0, final_score) in rank_candidates.
    """
    client = build_mock_client(JAZZ_USER)
    results = rank_candidates(
        client=client,
        user_id=JAZZ_USER.user_id,
        taste_vector=JAZZ_TASTE_VECTOR,
        prompt_vector=None,
        weights=_weights(),
        exclude_library=False,
        limit=20,
    )
    negative = [r for r in results if r["score"] < 0]
    passed = len(negative) == 0
    return EvalResult(
        name="scores_non_negative",
        passed=passed,
        score=1.0 if passed else 0.0,
        details=f"Negative-score results: {len(negative)}/{len(results)}",
    )


def eval_exploration_produces_variance() -> EvalResult:
    """Repeated calls with identical inputs should produce at least 2 distinct orderings.

    The ±8% exploration factor is specifically designed to shuffle mid-tier
    candidates so the user sees fresh results on every Discover session.
    """
    client = build_mock_client(JAZZ_USER)
    kwargs = dict(
        client=client,
        user_id=JAZZ_USER.user_id,
        taste_vector=JAZZ_TASTE_VECTOR,
        prompt_vector=None,
        weights=_weights(),
        exclude_library=False,
        limit=15,
    )
    orderings = [
        tuple(r["artist_id"] for r in rank_candidates(**kwargs))
        for _ in range(5)
    ]
    unique = len(set(orderings))
    passed = unique >= 2
    return EvalResult(
        name="exploration_produces_variance",
        passed=passed,
        score=unique / 5.0,
        details=f"Unique orderings across 5 identical calls: {unique}/5",
        threshold=0.3,
    )


def eval_editorial_recency_boost() -> EvalResult:
    """An artist with a fresh mention should rank above one with a stale mention.

    Recency multiplier: fresh (5 days) ≈ 0.89, stale (120 days) = 0.2.
    With trust=0.9 and sentiment=0.9, the editorial score gap is ~0.59.
    We use editorial-only weights (affinity=0, context=0) to fully isolate
    the recency signal, avoiding the percentile-rank lottery that occurs
    when two artists share an identical embedding.
    """
    # Use distinct vec_seeds so both artists get embeddings from different seeds
    artist_fresh = _make_artist(700, "Fresh Press Artist", ["jazz"], vec_seed=50, popularity=70)
    artist_stale = _make_artist(701, "Old Press Artist", ["jazz"], vec_seed=51, popularity=70)

    fresh_mention = _make_mention(80, 700, 1, sentiment=0.9, days_ago=5, vec_seed=180)
    stale_mention = _make_mention(81, 701, 1, sentiment=0.9, days_ago=120, vec_seed=181)

    scenario = UserScenario(
        user_id="recency_test",
        library_artist_ids=[],
        played_track_ids=[],
        top_artist_ids=[],
        taste_vector=JAZZ_TASTE_VECTOR,
    )
    client = build_mock_client(
        scenario,
        artists=[artist_fresh, artist_stale],
        tracks=[],
        mentions=[fresh_mention, stale_mention],
    )
    results = rank_candidates(
        client=client,
        user_id=scenario.user_id,
        taste_vector=JAZZ_TASTE_VECTOR,
        prompt_vector=None,
        # Editorial-only: isolates recency signal; avoids percentile-rank
        # lottery when both artists have similar taste affinity.
        weights={"affinity": 0.0, "context": 0.0, "editorial": 1.0},
        exclude_library=False,
        limit=5,
    )
    ids = [int(r["artist_id"]) for r in results]
    fresh_rank = ids.index(700) if 700 in ids else 999
    stale_rank = ids.index(701) if 701 in ids else 999
    passed = fresh_rank < stale_rank
    fresh_ed = next((r["signals"]["editorial"] for r in results if int(r["artist_id"]) == 700), 0)
    stale_ed = next((r["signals"]["editorial"] for r in results if int(r["artist_id"]) == 701), 0)
    return EvalResult(
        name="editorial_recency_boost",
        passed=passed,
        score=1.0 if passed else 0.0,
        details=(
            f"Fresh rank {fresh_rank} (editorial={fresh_ed:.3f}) "
            f"vs stale rank {stale_rank} (editorial={stale_ed:.3f})"
        ),
    )


def eval_percentile_rank_spread() -> EvalResult:
    """Percentile ranking should spread tightly-clustered cosine scores across 0–1.

    Raw cosine similarities typically cluster near 0.85 for embedding models.
    Without percentile ranking the UI sliders would produce barely visible
    score differences.
    """
    # Typical real-world cosine similarities: all bunched near 0.86
    raw_scores = [0.860, 0.870, 0.865, 0.855, 0.875, 0.880, 0.862, 0.858, 0.877, 0.863]
    ranks = _percentile_rank(raw_scores)
    spread = max(ranks) - min(ranks)
    passed = spread >= 0.9
    return EvalResult(
        name="percentile_rank_spread",
        passed=passed,
        score=round(spread, 4),
        details=(
            f"Spread of percentile ranks: {spread:.4f} "
            f"(raw range was only {max(raw_scores)-min(raw_scores):.4f})"
        ),
    )


def eval_exclude_library_flag() -> EvalResult:
    """When exclude_library=True, zero library artists should appear in results."""
    client = build_mock_client(JAZZ_USER)
    results = rank_candidates(
        client=client,
        user_id=JAZZ_USER.user_id,
        taste_vector=JAZZ_TASTE_VECTOR,
        prompt_vector=None,
        weights=_weights(),
        exclude_library=True,
        limit=20,
    )
    library_ids = set(JAZZ_USER.library_artist_ids)
    leaked = {int(r["artist_id"]) for r in results} & library_ids
    passed = len(leaked) == 0
    score = 1.0 - len(leaked) / max(len(library_ids), 1)
    return EvalResult(
        name="exclude_library_flag",
        passed=passed,
        score=round(score, 4),
        details=f"Library artists leaking into results: {leaked or 'none'}",
    )


def eval_diversity_rerank_pool_size() -> EvalResult:
    """_diversity_rerank must not return more than `limit` items.

    A basic contract test: whatever pool is passed, the output is bounded.
    """
    artists_with_genre = [
        {**a, "artist_id": str(a["id"]), "score": 0.9 - i * 0.01}
        for i, a in enumerate(ALL_ARTISTS)
    ]
    limit = 7
    result = _diversity_rerank(artists_with_genre, limit)
    passed = len(result) <= limit
    return EvalResult(
        name="diversity_rerank_pool_size",
        passed=passed,
        score=1.0 if passed else 0.0,
        details=f"Output length {len(result)} for limit={limit}",
    )


def eval_thumbs_down_penalizes_artist() -> EvalResult:
    """An artist with 4× thumbs-down should rank below a neutral artist with lower editorial.

    Uses editorial-only weights so affinity percentile rank doesn't interfere.
    Disliked artist: editorial ≈ 0.80 (sentiment=1.0) — naturally ranks higher
    Neutral artist: editorial ≈ 0.76 (sentiment=0.9) — naturally ranks lower
    After 4 thumbs-downs: disliked_score × max(0.15, 1-4×0.25) = ×0.15 → 0.12 < 0.76
    Gap (0.64) far exceeds max exploration swing (0.16), so result is deterministic.
    """
    neutral_a = _make_artist(700, "Neutral Artist", ["jazz"], vec_seed=50, popularity=70)
    disliked_a = _make_artist(701, "Disliked Artist", ["jazz"], vec_seed=51, popularity=70)

    neutral_mention = _make_mention(90, 700, 1, sentiment=0.9, days_ago=5, vec_seed=190)
    disliked_mention = _make_mention(91, 701, 1, sentiment=1.0, days_ago=5, vec_seed=191)

    scenario = UserScenario(
        user_id="feedback_down_test",
        library_artist_ids=[],
        played_track_ids=[],
        top_artist_ids=[],
        taste_vector=JAZZ_TASTE_VECTOR,
        # 4× thumbs-down → net artist_feedback = -4 → multiplier = max(0.15, 1-4×0.25) = 0.15
        feedback=[
            {"artist_id": 701, "spotify_track_id": f"sp_fb_701_{i}", "feedback": -1}
            for i in range(4)
        ],
    )
    client = build_mock_client(
        scenario,
        artists=[neutral_a, disliked_a],
        tracks=[],
        mentions=[neutral_mention, disliked_mention],
    )
    results = rank_candidates(
        client=client,
        user_id=scenario.user_id,
        taste_vector=JAZZ_TASTE_VECTOR,
        prompt_vector=None,
        # Editorial-only: eliminates affinity percentile-rank noise so the
        # feedback penalty is the deciding factor, not embedding geometry.
        weights={"affinity": 0.0, "context": 0.0, "editorial": 1.0},
        exclude_library=False,
        limit=5,
    )
    ids = [int(r["artist_id"]) for r in results]
    neutral_rank = ids.index(700) if 700 in ids else 999
    disliked_rank = ids.index(701) if 701 in ids else 999
    passed = neutral_rank < disliked_rank
    return EvalResult(
        name="thumbs_down_penalizes_artist",
        passed=passed,
        score=1.0 if passed else 0.0,
        details=f"Neutral artist rank {neutral_rank} vs thumbs-down artist rank {disliked_rank} (lower = better)",
    )


def eval_thumbs_up_boosts_artist() -> EvalResult:
    """An artist with 5× thumbs-up should rank above a neutral artist with higher editorial.

    Uses editorial-only weights so affinity percentile rank doesn't interfere.
    Liked artist: editorial ≈ 0.76 (sentiment=0.9) — naturally ranks lower
    Neutral artist: editorial ≈ 0.80 (sentiment=1.0) — naturally ranks higher
    After 5 thumbs-ups: liked_score × min(1.4, 1+5×0.08) = ×1.4 → 1.06 > 0.80
    Gap (0.26) far exceeds max exploration swing (0.16), so result is deterministic.
    """
    neutral_a = _make_artist(710, "Neutral Artist B", ["jazz"], vec_seed=52, popularity=70)
    liked_a = _make_artist(711, "Liked Artist", ["jazz"], vec_seed=53, popularity=70)

    neutral_mention = _make_mention(92, 710, 1, sentiment=1.0, days_ago=5, vec_seed=192)
    liked_mention = _make_mention(93, 711, 1, sentiment=0.9, days_ago=5, vec_seed=193)

    scenario = UserScenario(
        user_id="feedback_up_test",
        library_artist_ids=[],
        played_track_ids=[],
        top_artist_ids=[],
        taste_vector=JAZZ_TASTE_VECTOR,
        # 5× thumbs-up → net artist_feedback = +5 → multiplier = min(1.4, 1+5×0.08) = 1.4
        feedback=[
            {"artist_id": 711, "spotify_track_id": f"sp_fb_711_{i}", "feedback": 1}
            for i in range(5)
        ],
    )
    client = build_mock_client(
        scenario,
        artists=[neutral_a, liked_a],
        tracks=[],
        mentions=[neutral_mention, liked_mention],
    )
    results = rank_candidates(
        client=client,
        user_id=scenario.user_id,
        taste_vector=JAZZ_TASTE_VECTOR,
        prompt_vector=None,
        weights={"affinity": 0.0, "context": 0.0, "editorial": 1.0},
        exclude_library=False,
        limit=5,
    )
    ids = [int(r["artist_id"]) for r in results]
    neutral_rank = ids.index(710) if 710 in ids else 999
    liked_rank = ids.index(711) if 711 in ids else 999
    passed = liked_rank < neutral_rank
    return EvalResult(
        name="thumbs_up_boosts_artist",
        passed=passed,
        score=1.0 if passed else 0.0,
        details=f"Liked artist rank {liked_rank} vs neutral artist rank {neutral_rank} (lower = better)",
    )


# ── Suite runner ─────────────────────────────────────────────────


def run_suite() -> list[EvalResult]:
    return [
        eval_taste_alignment(),
        eval_library_penalty(),
        eval_previously_recommended_penalty(),
        eval_genre_diversity_cap(),
        eval_scores_non_negative(),
        eval_exploration_produces_variance(),
        eval_editorial_recency_boost(),
        eval_percentile_rank_spread(),
        eval_exclude_library_flag(),
        eval_diversity_rerank_pool_size(),
        eval_thumbs_down_penalizes_artist(),
        eval_thumbs_up_boosts_artist(),
    ]
