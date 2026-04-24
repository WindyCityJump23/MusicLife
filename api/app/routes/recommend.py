"""
The taste model.

Three signals:
  1. Personal affinity  — cosine(candidate_embedding, user_taste_vector)
  2. Contextual fit     — cosine(prompt_embedding, mention_embeddings) aggregated per artist
  3. Editorial heat     — recency + frequency + source trust_weight + sentiment

Final score = w1*affinity + w2*context + w3*editorial
Weights come from the request so the UI sliders drive them directly.
"""
from fastapi import APIRouter
from pydantic import BaseModel, Field, field_validator

from app.deps.auth import bearer_scheme, require_bearer_token
from app.services.embedding import embedder

router = APIRouter()


class RecommendRequest(BaseModel):
    user_id: str
    prompt: str | None = None
    weights: dict[str, float] = Field(
        default_factory=lambda: {"affinity": 0.4, "context": 0.4, "editorial": 0.2}
    )
    exclude_library: bool = True
    limit: int = Field(default=20, ge=1, le=100)

    @field_validator("weights")
    @classmethod
    def validate_weights(cls, weights: dict[str, float]) -> dict[str, float]:
        required = {"affinity", "context", "editorial"}
        if set(weights) != required:
            missing = required - set(weights)
            extra = set(weights) - required
            raise ValueError(f"weights must contain exactly {required}; missing={missing}, extra={extra}")

        total = sum(weights.values())
        if total <= 0:
            raise ValueError("weights must sum to a positive number")

        if any(value < 0 for value in weights.values()):
            raise ValueError("weights cannot be negative")

        return {k: v / total for k, v in weights.items()}


class RecommendResponse(BaseModel):
    results: list[dict]


@router.post("", response_model=RecommendResponse)
def recommend(
    req: RecommendRequest,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
):
    token = require_bearer_token(credentials)
    user_client = get_user_scoped_supabase(token)

    # 1. Build the user's taste vector: weighted centroid of artist embeddings
    #    from their listening history.
    taste_vector = _build_taste_vector(user_client, req.user_id)

    # 2. Embed the prompt if provided.
    prompt_vec = None
    if req.prompt:
        embedded = embedder.embed([req.prompt], input_type="query")
        prompt_vec = embedded[0] if embedded else None

    # 3. Candidate pool: all artists with embeddings, optionally excluding
    #    artists already in the user's library.
    # 4. Score each candidate with the three signals, combine, rank, return.
    from app.services.ranking import rank_candidates

    results = rank_candidates(
        client=user_client,
        user_id=req.user_id,
        taste_vector=taste_vector,
        prompt_vector=prompt_vec,
        weights=req.weights,
        exclude_library=req.exclude_library,
        limit=req.limit,
    )
    return RecommendResponse(results=results)


def _build_taste_vector(client, user_id: str) -> list[float]:
    """
    Weighted centroid: sum(play_count * artist_embedding) / sum(play_count),
    computed via SQL for speed. Returned as a plain list for downstream use.
    """
    from app.services.ranking import build_taste_vector

    return build_taste_vector(user_id)
