"""
The taste model.
"""
import random as _std_random
import time as _time
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, Field, field_validator

from app.deps.auth import bearer_scheme, ensure_valid_bearer_token, require_bearer_token
from app.services.rate_limit import recommend_limiter
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
from app.services.query_intent import interpret_music_prompt
from app.services.supabase_client import get_user_scoped_supabase

router = APIRouter()


DEFAULT_TASTE_MATCH_WEIGHTS = {"affinity": 0.75, "context": 0.15, "editorial": 0.1}


def _enforce_rate_limit(user_id: str) -> None:
    """Raise 429 (with Retry-After) when a user exceeds the recommend budget."""
    key = user_id or "anonymous"
    if not recommend_limiter.allow(key):
        retry_after = recommend_limiter.retry_after_seconds(key)
        raise HTTPException(
            status_code=429,
            detail="Too many recommendation requests. Please slow down.",
            headers={"Retry-After": str(retry_after)},
        )


class RecommendRequest(BaseModel):
    user_id: str
    prompt: str | None = None
    weights: dict[str, float] = Field(default_factory=lambda: DEFAULT_TASTE_MATCH_WEIGHTS.copy())
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
    query_intent: dict | None = None


class DiscoveryMixPreference(BaseModel):
    deep_cuts: float = Field(default=38, ge=0, le=100)
    popular: float = Field(default=38, ge=0, le=100)
    radio_hits: float = Field(default=24, ge=0, le=100)


class TasteStrategyPreference(BaseModel):
    genre_boosts: list[str] = Field(default_factory=list, max_length=12)
    genre_avoids: list[str] = Field(default_factory=list, max_length=12)
    discovery_mix: DiscoveryMixPreference = Field(default_factory=DiscoveryMixPreference)
    station_distance: str = Field(default="balanced", pattern="^(closer|balanced|further)$")
    familiarity: str = Field(default="balanced", pattern="^(anchors|balanced|surprises)$")
    live_expansion: str = Field(default="auto", pattern="^(auto|catalog|live)$")
    freshness: str = Field(default="balanced", pattern="^(newer|balanced|timeless)$")

    @field_validator("genre_boosts", "genre_avoids")
    @classmethod
    def validate_genres(cls, genres: list[str]) -> list[str]:
        seen: set[str] = set()
        cleaned: list[str] = []
        for genre in genres:
            text = str(genre or "").strip().lower()
            if not text or text in seen:
                continue
            seen.add(text)
            cleaned.append(text[:48])
        return cleaned


class RecommendSongsRequest(BaseModel):
    user_id: str
    prompt: str | None = None
    weights: dict[str, float] = Field(default_factory=lambda: DEFAULT_TASTE_MATCH_WEIGHTS.copy())
    exclude_library: bool = False
    exclude_saved_tracks: bool = True
    limit: int = Field(default=30, ge=1, le=100)
    exclude_previously_shown: bool = True
    history_window_runs: int = Field(default=15, ge=1, le=500)
    max_allowed_overlap: float = Field(default=0.0, ge=0.0, le=1.0)
    novelty_mode: str = Field(default="strict", pattern="^(strict|graceful)$")
    discover_run_id: str | None = None
    taste_strategy: TasteStrategyPreference | None = None

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


class LiveCandidateIntentsRequest(BaseModel):
    user_id: str
    prompt: str | None = None
    limit: int = Field(default=8, ge=1, le=12)
    genre_boosts: list[str] = Field(default_factory=list)
    genre_avoids: list[str] = Field(default_factory=list)
    freshness: str = Field(default="balanced", pattern="^(newer|balanced|timeless)$")


@router.post("", response_model=RecommendResponse)
def recommend(req: RecommendRequest, credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme)):
    token = require_bearer_token(credentials)
    ensure_valid_bearer_token(token)
    _enforce_rate_limit(req.user_id)
    user_client = get_user_scoped_supabase(token)
    taste_vector = _build_taste_vector(user_client, req.user_id)
    query_intent = interpret_music_prompt(req.prompt)
    prompt_vec = None
    if query_intent:
        try:
            embedded = embedder.embed([query_intent.expanded_prompt], input_type="query")
            prompt_vec = embedded[0] if embedded else None
        except Exception as e:
            print(f"recommend: prompt embedding failed — {e}")
    from app.services.ranking import rank_candidates
    results = rank_candidates(client=user_client, user_id=req.user_id, taste_vector=taste_vector, prompt_vector=prompt_vec, weights=req.weights, exclude_library=req.exclude_library, limit=req.limit)
    return {"results": results, "query_intent": query_intent.as_response() if query_intent else None}


@router.post("/songs")
def recommend_songs(req: RecommendSongsRequest, credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme)):
    route_start = _time.monotonic()
    timings: dict[str, int] = {}
    token = require_bearer_token(credentials)
    ensure_valid_bearer_token(token)
    _enforce_rate_limit(req.user_id)
    user_client = get_user_scoped_supabase(token)
    taste_start = _time.monotonic()
    from app.services.ranking import build_taste_profile
    taste_vector, taste_clusters = build_taste_profile(user_client, req.user_id)
    timings["taste_vector_ms"] = round((_time.monotonic() - taste_start) * 1000)
    query_intent = interpret_music_prompt(req.prompt)
    prompt_for_ranking = query_intent.search_phrase if query_intent else req.prompt

    prompt_vec = None
    if query_intent:
        try:
            prompt_start = _time.monotonic()
            embedded = embedder.embed([query_intent.expanded_prompt], input_type="query")
            prompt_vec = embedded[0] if embedded else None
            timings["prompt_embedding_ms"] = round((_time.monotonic() - prompt_start) * 1000)
        except Exception as e:
            print(f"recommend_songs: prompt embedding failed — {e}. Continuing without prompt vector.")

    history_rows = load_recent_history(user_client, req.user_id, req.history_window_runs)

    excluded_track_ids: set[str] = set()
    excluded_artist_ids: set[int] = set()
    if req.exclude_previously_shown:
        excluded_track_ids = build_excluded_track_ids(history_rows)
        excluded_artist_ids = build_excluded_artist_ids(history_rows)

    if query_intent:
        excluded_track_ids = build_excluded_track_ids(history_rows, older_than_days=3)
        excluded_artist_ids = build_excluded_artist_ids(history_rows, older_than_days=3)

    from app.services.song_ranking import recommend_songs as _recommend_songs

    request_base_seed = _std_random.randint(0, 2**31)

    best_results: list[dict] = []
    attempts = 0
    run_id = req.discover_run_id or str(uuid4())
    overlap = 0.0
    _start_time = _time.monotonic()
    _TIME_BUDGET_SEC = 16.0 if query_intent else 12.0
    warnings: list[str] = []

    def _source_mix(results: list[dict]) -> dict:
        live_count = sum(
            1
            for row in results
            if row.get("track_id") is None
            or str(row.get("artist_id") or "").startswith("live:")
            or "live spotify" in " ".join(row.get("reasons") or []).lower()
            or "outside catalog" in " ".join(row.get("reasons") or []).lower()
        )
        # Lane distribution per station, persisted with the run telemetry so
        # radio-health can detect a silently empty lane (the radio_hits lane
        # sat at zero for weeks before anything surfaced it).
        lane_counts: dict[str, int] = {}
        for row in results:
            lane = str(row.get("lane") or "unknown")
            lane_counts[lane] = lane_counts.get(lane, 0) + 1
        return {
            "catalogCount": max(0, len(results) - live_count),
            "liveCount": live_count,
            "laneCounts": lane_counts,
        }

    def _numeric_artist_ids(results: list[dict]) -> list[int]:
        ids: list[int] = []
        for row in results:
            try:
                ids.append(int(row["artist_id"]))
            except (KeyError, TypeError, ValueError):
                continue
        return ids

    def _response(
        results: list[dict],
        *,
        signature: str,
        novelty_mode_used: str,
        fallback_level: str,
        status_warning: str | None = None,
    ) -> dict:
        if status_warning:
            warnings.append(status_warning)
        elapsed_ms = round((_time.monotonic() - route_start) * 1000)
        print(f"recommend_songs: timings={timings}")
        return {
            "results": results,
            "query_intent": query_intent.as_response() if query_intent else None,
            "run_id": run_id,
            "station_id": run_id,
            "list_signature": signature,
            "novelty_attempts": attempts,
            "overlap_ratio": round(overlap, 4),
            "artist_overlap_ratio": round(artist_overlap_ratio(
                _numeric_artist_ids(results),
                excluded_artist_ids,
            ), 4),
            "novelty_mode_used": novelty_mode_used,
            "fallback_level": fallback_level,
            "timing_ms": elapsed_ms,
            "timings": timings,
            "source_mix": _source_mix(results),
            "warnings": warnings,
        }

    for attempt in range(5):
        if _time.monotonic() - _start_time > _TIME_BUDGET_SEC:
            print(f"recommend_songs: time budget exhausted after {attempts} attempts, returning best_results ({len(best_results)} tracks)")
            warnings.append("time_budget_exhausted")
            break

        attempts = attempt + 1
        local_excluded_tracks = excluded_track_ids
        local_excluded_artists = excluded_artist_ids

        if not query_intent and req.novelty_mode == "graceful" and attempt >= 2:
            local_excluded_tracks = build_excluded_track_ids(history_rows, older_than_days=30)
            local_excluded_artists = build_excluded_artist_ids(history_rows, older_than_days=30)

        if attempt >= 1 and len(best_results) == 0:
            local_excluded_artists = set()
            local_excluded_tracks = build_excluded_track_ids(history_rows, older_than_days=3)

        rank_start = _time.monotonic()
        rank_stage_timings: dict[str, int] = {}
        attempt_results = _recommend_songs(
            client=user_client,
            user_id=req.user_id,
            taste_vector=taste_vector,
            prompt_vector=prompt_vec,
            weights=req.weights,
            exclude_library=req.exclude_library,
            limit=req.limit,
            exclude_saved_tracks=req.exclude_saved_tracks,
            prompt_text=prompt_for_ranking,
            excluded_track_ids=local_excluded_tracks,
            excluded_artist_ids=local_excluded_artists,
            exploration_seed=request_base_seed + attempt,
            taste_strategy=req.taste_strategy.model_dump() if req.taste_strategy and not query_intent else None,
            taste_clusters=taste_clusters,
            performance_timings=rank_stage_timings,
        )
        timings[f"rank_attempt_{attempts}_ms"] = round((_time.monotonic() - rank_start) * 1000)
        for key, value in rank_stage_timings.items():
            timings[f"rank_attempt_{attempts}_{key}"] = value

        if len(attempt_results) > len(best_results):
            best_results = attempt_results

        track_ids = [r.get("spotify_track_id") for r in attempt_results if r.get("spotify_track_id")]
        result_artist_ids = _numeric_artist_ids(attempt_results)
        signature = signature_from_ordered(track_ids)
        overlap = overlap_ratio(track_ids, excluded_track_ids)
        a_overlap = artist_overlap_ratio(result_artist_ids, excluded_artist_ids)

        if has_signature_collision(user_client, req.user_id, signature):
            continue
        # Prompted searches use a shorter history window, so do not run the
        # strict unprompted novelty retry loop against them.
        if not query_intent and req.novelty_mode == "strict" and req.exclude_previously_shown:
            if overlap > 0 or a_overlap > 0.3:
                continue
        if not query_intent and req.novelty_mode == "graceful" and overlap > req.max_allowed_overlap:
            continue

        persistence_start = _time.monotonic()
        try:
            persist_discover_run(
                user_client,
                req.user_id,
                track_ids,
                req.prompt,
                req.weights,
                run_id=run_id,
                results=attempt_results,
            )
        except Exception as e:
            print(f"persist_discover_run failed (non-fatal): {e}")
        finally:
            timings["persistence_ms"] = round((_time.monotonic() - persistence_start) * 1000)
        return _response(
            attempt_results,
            signature=signature,
            novelty_mode_used=req.novelty_mode,
            fallback_level="fresh" if len(attempt_results) >= req.limit else "partial",
        )

    # All attempts failed novelty checks — return the best result we found
    track_ids = [r.get("spotify_track_id") for r in best_results if r.get("spotify_track_id")]
    result_artist_ids = _numeric_artist_ids(best_results)
    signature = signature_from_ordered(track_ids)
    persistence_start = _time.monotonic()
    try:
        persist_discover_run(
            user_client,
            req.user_id,
            track_ids,
            req.prompt,
            req.weights,
            run_id=run_id,
            results=best_results,
        )
    except Exception as e:
        print(f"persist_discover_run failed (non-fatal): {e}")
    finally:
        timings["persistence_ms"] = round((_time.monotonic() - persistence_start) * 1000)
    return _response(
        best_results,
        signature=signature,
        novelty_mode_used="graceful",
        fallback_level="partial" if best_results else "empty",
        status_warning="returned_best_partial_after_novelty_checks" if best_results else "no_results",
    )


@router.post("/songs/live-intents")
def live_candidate_intents(
    req: LiveCandidateIntentsRequest,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
):
    token = require_bearer_token(credentials)
    ensure_valid_bearer_token(token)
    user_client = get_user_scoped_supabase(token)
    from app.services.live_candidate_intents import build_live_candidate_intents

    return build_live_candidate_intents(
        client=user_client,
        user_id=req.user_id,
        prompt=req.prompt,
        limit=req.limit,
        genre_boosts=req.genre_boosts,
        genre_avoids=req.genre_avoids,
        freshness=req.freshness,
    )


def _build_taste_vector(client, user_id: str) -> list[float]:
    from app.services.ranking import build_taste_vector
    return build_taste_vector(client, user_id)
