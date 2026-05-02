"""
The taste model.
"""
import random as _std_random
import time
from uuid import uuid4

from fastapi import APIRouter, Depends
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, Field, field_validator

from app.deps.auth import bearer_scheme, ensure_valid_bearer_token, require_bearer_token
from app.services.discover_novelty import (
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
        embedded = embedder.embed([req.prompt], input_type="query")
        prompt_vec = embedded[0] if embedded else None
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
        embedded = embedder.embed([req.prompt], input_type="query")
        prompt_vec = embedded[0] if embedded else None

    history_rows = load_recent_history(user_client, req.user_id, req.history_window_runs)
    excluded_track_ids = set()
    if req.exclude_previously_shown:
        excluded_track_ids = build_excluded_track_ids(history_rows)

    # Genre/mood prompts are intentional searches — the user wants the best
    # matching songs, not just ones they haven't seen. Don't exclude history
    # for explicit prompts; save exclusion for unprompted browsing where
    # "show me something new" is the implicit intent.
    if req.prompt:
        excluded_track_ids = set()

    from app.services.song_ranking import recommend_songs as _recommend_songs

    # Unique seed per request — without this, seed=0 always gives identical
    # track ordering and results feel the same on every load.
    request_base_seed = _std_random.randint(0, 2**31)

    best_results: list[dict] = []
    attempts = 0
    run_id = req.discover_run_id or str(uuid4())
    overlap = 0.0

    for attempt in range(5):
        attempts = attempt + 1
        local_excluded = excluded_track_ids
        if not req.prompt and req.novelty_mode == "graceful" and attempt >= 2:
            local_excluded = build_excluded_track_ids(history_rows, older_than_days=30)

        attempt_results = _recommend_songs(
            client=user_client,
            user_id=req.user_id,
            taste_vector=taste_vector,
            prompt_vector=prompt_vec,
            weights=req.weights,
            exclude_library=req.exclude_library,
            limit=req.limit,
            prompt_text=req.prompt,
            excluded_track_ids=local_excluded,
            exploration_seed=request_base_seed + attempt,
        )

        # Keep whichever attempt produced the most songs — use as fallback
        if len(attempt_results) > len(best_results):
            best_results = attempt_results

        track_ids = [r.get("spotify_track_id") for r in attempt_results if r.get("spotify_track_id")]
        signature = signature_from_ordered(track_ids)
        overlap = overlap_ratio(track_ids, excluded_track_ids)

        if has_signature_collision(user_client, req.user_id, signature):
            continue
        # For prompted searches exclusion is already cleared above, so overlap
        # is always 0 — skip the strict check to avoid unnecessary retries.
        if not req.prompt and req.novelty_mode == "strict" and req.exclude_previously_shown and overlap > 0:
            continue
        if not req.prompt and req.novelty_mode == "graceful" and overlap > req.max_allowed_overlap:
            continue

        persist_discover_run(user_client, req.user_id, track_ids, req.prompt, req.weights, run_id=run_id)
        return {
            "results": attempt_results,
            "run_id": run_id,
            "list_signature": signature,
            "novelty_attempts": attempts,
            "overlap_ratio": round(overlap, 4),
            "novelty_mode_used": req.novelty_mode,
        }

    # All attempts failed novelty checks — return the best result we found
    track_ids = [r.get("spotify_track_id") for r in best_results if r.get("spotify_track_id")]
    signature = signature_from_ordered(track_ids)
    persist_discover_run(user_client, req.user_id, track_ids, req.prompt, req.weights, run_id=run_id)
    return {
        "results": best_results,
        "run_id": run_id,
        "list_signature": signature,
        "novelty_attempts": attempts,
        "overlap_ratio": round(overlap, 4),
        "novelty_mode_used": "graceful",
    }


def _build_taste_vector(client, user_id: str) -> list[float]:
    from app.services.ranking import build_taste_vector
    return build_taste_vector(client, user_id)
