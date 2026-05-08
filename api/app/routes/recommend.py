"""
The taste model.
"""
import random as _std_random
from collections import Counter
from uuid import uuid4

from fastapi import APIRouter, Depends
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, Field, field_validator

from app.deps.auth import bearer_scheme, ensure_valid_bearer_token, require_bearer_token
from app.services.discover_novelty import (
    artist_overlap_ratio,
    build_excluded_artist_ids,
    build_excluded_track_ids,
    has_signature_collision,
    load_recent_history,
    overlap_ratio,
    persist_discover_run,
    signature_from_ordered,
)
from app.services.embedding import embedder
from app.services.supabase_client import get_user_scoped_supabase

router = APIRouter()


class RecommendRequest(BaseModel):
    user_id: str
    prompt: str | None = None
    weights: dict[str, float] = Field(default_factory=lambda: {"affinity": 0.4, "context": 0.4, "editorial": 0.2})
    exclude_library: bool = False
    limit: int = Field(default=20, ge=1, le=100)

    @field_validator("weights")
    @classmethod
    def validate_weights(cls, weights: dict[str, float]) -> dict[str, float]:
        required = {"affinity", "context", "editorial"}
        if set(weights) != required:
            raise ValueError("weights must contain affinity/context/editorial")
        total = sum(weights.values())
        if total <= 0 or any(value < 0 for value in weights.values()):
            raise ValueError("invalid weights")
        return {k: v / total for k, v in weights.items()}


class RecommendResponse(BaseModel):
    results: list[dict]


class RecommendSongsRequest(BaseModel):
    user_id: str
    prompt: str | None = None
    weights: dict[str, float] = Field(default_factory=lambda: {"affinity": 0.4, "context": 0.4, "editorial": 0.2})
    exclude_library: bool = False
    limit: int = Field(default=30, ge=1, le=100)
    exclude_previously_shown: bool = True
    history_window_runs: int = Field(default=15, ge=1, le=500)
    max_allowed_overlap: float = Field(default=0.0, ge=0.0, le=1.0)
    novelty_mode: str = Field(default="strict", pattern="^(strict|graceful)$")
    discover_run_id: str | None = None

    @field_validator("weights")
    @classmethod
    def validate_song_weights(cls, weights: dict[str, float]) -> dict[str, float]:
        required = {"affinity", "context", "editorial"}
        if set(weights) != required:
            raise ValueError("weights must contain affinity/context/editorial")
        total = sum(weights.values())
        if total <= 0 or any(value < 0 for value in weights.values()):
            raise ValueError("invalid weights")
        return {k: v / total for k, v in weights.items()}


@router.post("", response_model=RecommendResponse)
def recommend(req: RecommendRequest, credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme)):
    token = require_bearer_token(credentials)
    ensure_valid_bearer_token(token)
    user_client = get_user_scoped_supabase(token)
    taste_vector = _build_taste_vector(user_client, req.user_id)
    prompt_vec = None
    if req.prompt:
        try:
            embedded = embedder.embed([req.prompt], input_type="query")
            prompt_vec = embedded[0] if embedded else None
        except Exception as e:
            print(f"recommend: prompt embedding failed — {e}")
    from app.services.ranking import rank_candidates
    results = rank_candidates(client=user_client, user_id=req.user_id, taste_vector=taste_vector, prompt_vector=prompt_vec, weights=req.weights, exclude_library=req.exclude_library, limit=req.limit)
    return RecommendResponse(results=results)


@router.post("/songs")
def recommend_songs(req: RecommendSongsRequest, credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme)):
    token = require_bearer_token(credentials)
    ensure_valid_bearer_token(token)
    user_client = get_user_scoped_supabase(token)
    taste_vector = _build_taste_vector(user_client, req.user_id)

    prompt_vec = None
    if req.prompt:
        try:
            embedded = embedder.embed([req.prompt], input_type="query")
            prompt_vec = embedded[0] if embedded else None
        except Exception as e:
            print(f"recommend_songs: prompt embedding failed — {e}. Continuing without prompt vector.")

    history_rows = load_recent_history(user_client, req.user_id, req.history_window_runs)

    excluded_track_ids: set[str] = set()
    excluded_artist_ids: set[int] = set()
    if req.exclude_previously_shown:
        excluded_track_ids = build_excluded_track_ids(history_rows)
        excluded_artist_ids = build_excluded_artist_ids(history_rows)

    # For prompted searches, use lighter exclusion: still exclude exact
    # tracks shown recently, but allow artist repeats. The old code cleared
    # exclusion entirely for prompts, which meant the same genre search
    # returned identical results every time.
    if req.prompt:
        excluded_artist_ids = set()

    from app.services.song_ranking import recommend_songs as _recommend_songs

    request_base_seed = _std_random.randint(0, 2**31)

    best_results: list[dict] = []
    attempts = 0
    run_id = req.discover_run_id or str(uuid4())
    overlap = 0.0

    for attempt in range(5):
        attempts = attempt + 1
        local_excluded_tracks = excluded_track_ids
        local_excluded_artists = excluded_artist_ids

        if not req.prompt and req.novelty_mode == "graceful" and attempt >= 2:
            local_excluded_tracks = build_excluded_track_ids(history_rows, older_than_days=30)
            local_excluded_artists = build_excluded_artist_ids(history_rows, older_than_days=30)

        attempt_results = _recommend_songs(
            client=user_client,
            user_id=req.user_id,
            taste_vector=taste_vector,
            prompt_vector=prompt_vec,
            weights=req.weights,
            exclude_library=req.exclude_library,
            limit=req.limit,
            prompt_text=req.prompt,
            excluded_track_ids=local_excluded_tracks,
            excluded_artist_ids=local_excluded_artists,
            exploration_seed=request_base_seed + attempt,
        )

        if len(attempt_results) > len(best_results):
            best_results = attempt_results

        track_ids = [r.get("spotify_track_id") for r in attempt_results if r.get("spotify_track_id")]
        result_artist_ids = [int(r["artist_id"]) for r in attempt_results if r.get("artist_id")]
        signature = signature_from_ordered(track_ids)
        overlap = overlap_ratio(track_ids, excluded_track_ids)
        a_overlap = artist_overlap_ratio(result_artist_ids, excluded_artist_ids)

        if has_signature_collision(user_client, req.user_id, signature):
            continue
        if not req.prompt and req.novelty_mode == "strict" and req.exclude_previously_shown:
            if overlap > 0 or a_overlap > 0.3:
                continue
        if not req.prompt and req.novelty_mode == "graceful" and overlap > req.max_allowed_overlap:
            continue

        lane_dist = _count_lanes(attempt_results)
        persist_discover_run(
            user_client, req.user_id, track_ids, result_artist_ids,
            req.prompt, req.weights, lane_distribution=lane_dist, run_id=run_id,
        )
        return {
            "results": attempt_results,
            "run_id": run_id,
            "list_signature": signature,
            "novelty_attempts": attempts,
            "overlap_ratio": round(overlap, 4),
            "artist_overlap_ratio": round(a_overlap, 4),
            "novelty_mode_used": req.novelty_mode,
        }

    # All attempts failed novelty checks — return the best result we found
    track_ids = [r.get("spotify_track_id") for r in best_results if r.get("spotify_track_id")]
    result_artist_ids = [int(r["artist_id"]) for r in best_results if r.get("artist_id")]
    signature = signature_from_ordered(track_ids)
    lane_dist = _count_lanes(best_results)
    persist_discover_run(
        user_client, req.user_id, track_ids, result_artist_ids,
        req.prompt, req.weights, lane_distribution=lane_dist, run_id=run_id,
    )
    return {
        "results": best_results,
        "run_id": run_id,
        "list_signature": signature,
        "novelty_attempts": attempts,
        "overlap_ratio": round(overlap, 4),
        "artist_overlap_ratio": round(artist_overlap_ratio(result_artist_ids, excluded_artist_ids), 4),
        "novelty_mode_used": "graceful",
    }


def _count_lanes(results: list[dict]) -> dict[str, int]:
    counts: Counter[str] = Counter()
    for r in results:
        lane = r.get("lane", "unknown")
        counts[lane] += 1
    return dict(counts)


def _build_taste_vector(client, user_id: str) -> list[float]:
    from app.services.ranking import build_taste_vector
    return build_taste_vector(client, user_id)
