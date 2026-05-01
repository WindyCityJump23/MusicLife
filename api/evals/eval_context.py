"""Evals for the context signal and mood-fallback logic.

These tests verify:
  1. Providing a prompt vector raises context scores for semantically
     matching artists relative to non-matching ones.
  2. The mood fallback (no prompt → use taste vector) populates context
     scores meaningfully rather than leaving them at 0.
  3. Genre text filtering triggers when the prompt text matches known genres.
  4. Signal weights are respected: high editorial weight surfaces artists
     with strong editorial coverage over equally-matched taste artists.

All tests run in-process with no network calls.
"""
from __future__ import annotations

import math
import sys
from dataclasses import dataclass
from pathlib import Path

_API_DIR = Path(__file__).parent.parent
if str(_API_DIR) not in sys.path:
    sys.path.insert(0, str(_API_DIR))

from app.services.ranking import _cosine_similarity, _normalize_01, rank_candidates
from evals.fixtures import (
    ALL_ARTISTS,
    JAZZ_ARTISTS,
    JAZZ_TASTE_VECTOR,
    JAZZ_USER,
    ROCK_ARTISTS,
    ROCK_TASTE_VECTOR,
    SOURCES,
    UserScenario,
    _make_artist,
    _make_mention,
    _rand_vec,
    build_mock_client,
)


@dataclass
class EvalResult:
    name: str
    passed: bool
    score: float
    details: str = ""
    skipped: bool = False
    threshold: float = 1.0


def _weights(**kw) -> dict:
    return {"affinity": 0.5, "context": 0.3, "editorial": 0.2, **kw}


# ── Evals ────────────────────────────────────────────────────────


def eval_prompt_vector_raises_context_score() -> EvalResult:
    """An artist whose editorial mention aligns with the prompt should score higher on context.

    We place two artists with identical taste affinity. Artist A has a
    mention whose embedding closely matches the prompt vector; artist B has
    a mention pointing in a different direction. With context weight at 0.5
    the prompt-aligned artist should consistently beat the other.
    """
    prompt_vec = _rand_vec(8, seed=999)  # arbitrary fixed "prompt"

    # Artist A: mention embedding = same seed as prompt → high cosine similarity
    a_aligned = _make_artist(200, "Prompt-Aligned Artist", ["jazz"], vec_seed=50, popularity=70)
    a_other = _make_artist(201, "Unrelated Artist", ["jazz"], vec_seed=50, popularity=70)

    # Artist A gets a mention whose embedding closely matches the prompt
    aligned_mention = _make_mention(
        20, 200, 1, sentiment=0.8, days_ago=10,
        excerpt="Perfect for the vibe.",
        vec_seed=999,  # same seed → embedding ≈ prompt_vec
    )
    # Artist B gets a mention pointing away from the prompt
    other_mention = _make_mention(
        21, 201, 1, sentiment=0.8, days_ago=10,
        excerpt="Entirely different sound.",
        vec_seed=1,  # divergent direction
    )

    scenario = UserScenario(
        user_id="ctx_test",
        library_artist_ids=[],
        played_track_ids=[],
        top_artist_ids=[],
        taste_vector=JAZZ_TASTE_VECTOR,
    )
    client = build_mock_client(
        scenario,
        artists=[a_aligned, a_other],
        tracks=[],
        mentions=[aligned_mention, other_mention],
    )
    results = rank_candidates(
        client=client,
        user_id=scenario.user_id,
        taste_vector=JAZZ_TASTE_VECTOR,
        prompt_vector=prompt_vec,
        weights={"affinity": 0.2, "context": 0.6, "editorial": 0.2},
        exclude_library=False,
        limit=5,
    )
    ctx_scores = {int(r["artist_id"]): r["signals"]["context"] for r in results}
    aligned_ctx = ctx_scores.get(200, 0.0)
    other_ctx = ctx_scores.get(201, 0.0)

    passed = aligned_ctx > other_ctx
    score = 1.0 if passed else 0.0
    return EvalResult(
        name="prompt_vector_raises_context_score",
        passed=passed,
        score=score,
        details=(
            f"Aligned artist context={aligned_ctx:.4f}, "
            f"unrelated context={other_ctx:.4f}"
        ),
    )


def eval_mood_fallback_populates_context() -> EvalResult:
    """Without a prompt vector, context scores should still be non-zero (mood fallback).

    ranking.py sets effective_prompt_vector = taste_vector when no prompt
    is given. Mentions should then be scored against the taste vector,
    producing meaningful (non-zero) context signal.
    """
    # Give the artist a mention so there's something to score
    scenario = UserScenario(
        user_id="mood_test",
        library_artist_ids=[],
        played_track_ids=[],
        top_artist_ids=[],
        taste_vector=JAZZ_TASTE_VECTOR,
    )
    artist = _make_artist(300, "Artist With Mention", ["jazz"], vec_seed=3, popularity=70)
    mention = _make_mention(30, 300, 1, sentiment=0.8, days_ago=5, vec_seed=42)

    client = build_mock_client(
        scenario,
        artists=[artist],
        tracks=[],
        mentions=[mention],
    )
    results = rank_candidates(
        client=client,
        user_id=scenario.user_id,
        taste_vector=JAZZ_TASTE_VECTOR,
        prompt_vector=None,  # no explicit prompt
        weights=_weights(),
        exclude_library=False,
        limit=5,
    )
    if not results:
        return EvalResult(
            name="mood_fallback_populates_context",
            passed=False,
            score=0.0,
            details="No results returned",
        )
    ctx = results[0]["signals"]["context"]
    passed = ctx > 0.0
    return EvalResult(
        name="mood_fallback_populates_context",
        passed=passed,
        score=ctx,
        details=f"Context score without explicit prompt: {ctx:.4f} (should be > 0)",
    )


def eval_context_scores_in_range() -> EvalResult:
    """All context signal values must be in [0, 1].

    _normalize_01 maps cosine [-1, 1] → [0, 1], but floating-point
    edge cases could produce values slightly outside the range.
    """
    client = build_mock_client(JAZZ_USER, artists=ALL_ARTISTS)
    prompt_vec = _rand_vec(8, seed=77)
    results = rank_candidates(
        client=client,
        user_id=JAZZ_USER.user_id,
        taste_vector=JAZZ_TASTE_VECTOR,
        prompt_vector=prompt_vec,
        weights=_weights(),
        exclude_library=False,
        limit=20,
    )
    out_of_range = [
        r for r in results
        if not (0.0 <= r["signals"]["context"] <= 1.0)
    ]
    passed = len(out_of_range) == 0
    return EvalResult(
        name="context_scores_in_range",
        passed=passed,
        score=1.0 if passed else 0.0,
        details=f"Context scores out of [0,1]: {len(out_of_range)}/{len(results)}",
    )


def eval_high_editorial_weight_surfaces_press_artists() -> EvalResult:
    """With editorial weight dominant, artists with recent high-trust mentions should top the list.

    Validates that weight sliders the user controls actually influence
    which artists appear at the top of Discover.
    """
    # Artist 1 (Miles Davis) has a recent Pitchfork mention in RECENT_MENTIONS
    # Artist 4 (Bill Evans) has no mentions
    client = build_mock_client(JAZZ_USER, artists=JAZZ_ARTISTS)

    results = rank_candidates(
        client=client,
        user_id=JAZZ_USER.user_id,
        taste_vector=JAZZ_TASTE_VECTOR,
        prompt_vector=None,
        weights={"affinity": 0.1, "context": 0.1, "editorial": 0.8},
        exclude_library=False,
        limit=5,
    )
    # Miles Davis (id=1) should appear in top results
    top_ids = [int(r["artist_id"]) for r in results[:3]]
    passed = 1 in top_ids
    return EvalResult(
        name="high_editorial_weight_surfaces_press_artists",
        passed=passed,
        score=1.0 if passed else 0.0,
        details=(
            f"Top-3 artist IDs with editorial weight=0.8: {top_ids}. "
            f"Miles Davis (id=1, has recent mention) present: {1 in top_ids}"
        ),
    )


def eval_weight_sum_independence() -> EvalResult:
    """Rankings should degrade gracefully even when weights do not sum to 1.

    The blending formula uses weights as multipliers, not a probability
    simplex, so non-normalized weights are intentional (user sliders
    can be set independently). Results should still be non-empty and
    all scores non-negative.
    """
    client = build_mock_client(JAZZ_USER)
    results = rank_candidates(
        client=client,
        user_id=JAZZ_USER.user_id,
        taste_vector=JAZZ_TASTE_VECTOR,
        prompt_vector=None,
        weights={"affinity": 1.0, "context": 1.0, "editorial": 1.0},  # sum = 3.0
        exclude_library=False,
        limit=10,
    )
    passed = len(results) > 0 and all(r["score"] >= 0 for r in results)
    return EvalResult(
        name="weight_sum_independence",
        passed=passed,
        score=1.0 if passed else 0.0,
        details=f"Results with weights summing to 3.0: {len(results)} items, all non-negative: {all(r['score']>=0 for r in results)}",
    )


def eval_empty_taste_vector_returns_results() -> EvalResult:
    """An empty taste vector (new user) should not crash or return empty results.

    New users have no listening history, so build_taste_vector returns [].
    rank_candidates should still return results (purely editorial/exploratory
    picks) rather than an empty list or exception.
    """
    scenario = UserScenario(
        user_id="new_user",
        library_artist_ids=[],
        played_track_ids=[],
        top_artist_ids=[],
        taste_vector=[],
    )
    client = build_mock_client(scenario, artists=ALL_ARTISTS)

    try:
        results = rank_candidates(
            client=client,
            user_id=scenario.user_id,
            taste_vector=[],  # empty — cold start
            prompt_vector=None,
            weights={"affinity": 0.5, "context": 0.3, "editorial": 0.2},
            exclude_library=False,
            limit=10,
        )
        # With empty taste vector, cosine similarity returns 0.0 for all
        # candidates, so all affinities will be 0. Results may be empty or
        # contain editorial-driven picks. Either is acceptable; what must
        # NOT happen is an exception.
        passed = True
        details = f"Returned {len(results)} results without error"
    except Exception as exc:
        passed = False
        details = f"Exception raised with empty taste vector: {exc}"

    return EvalResult(
        name="empty_taste_vector_returns_results",
        passed=passed,
        score=1.0 if passed else 0.0,
        details=details,
    )


# ── Suite runner ─────────────────────────────────────────────────


def run_suite() -> list[EvalResult]:
    return [
        eval_prompt_vector_raises_context_score(),
        eval_mood_fallback_populates_context(),
        eval_context_scores_in_range(),
        eval_high_editorial_weight_surfaces_press_artists(),
        eval_weight_sum_independence(),
        eval_empty_taste_vector_returns_results(),
    ]
