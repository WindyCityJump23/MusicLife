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
from pydantic import BaseModel

from app.services.embedding import embedder
from app.services.supabase_client import supabase

router = APIRouter()


class RecommendRequest(BaseModel):
    user_id: str
    prompt: str | None = None
    weights: dict[str, float] = {"affinity": 0.4, "context": 0.4, "editorial": 0.2}
    exclude_library: bool = True
    limit: int = 20


class RecommendResponse(BaseModel):
    results: list[dict]


@router.post("", response_model=RecommendResponse)
def recommend(req: RecommendRequest):
    # 1. Build the user's taste vector: weighted centroid of artist embeddings
    #    from their listening history.
    taste_vector = _build_taste_vector(req.user_id)

    # 2. Embed the prompt if provided.
    prompt_vec = None
    if req.prompt:
        prompt_vec = embedder.embed([req.prompt], input_type="query")[0]

    # 3. Candidate pool: all artists with embeddings, optionally excluding
    #    artists already in the user's library.
    # 4. Score each candidate with the three signals, combine, rank, return.
    #
    # Actual SQL lives in app/services/ranking.py — stub for now so the
    # endpoint shape is nailed down before implementation.
    from app.services.ranking import rank_candidates

    results = rank_candidates(
        user_id=req.user_id,
        taste_vector=taste_vector,
        prompt_vector=prompt_vec,
        weights=req.weights,
        exclude_library=req.exclude_library,
        limit=req.limit,
    )
    return RecommendResponse(results=results)


def _build_taste_vector(user_id: str) -> list[float]:
    """
    Weighted centroid: sum(play_count * artist_embedding) / sum(play_count),
    computed via SQL for speed. Returned as a plain list for downstream use.
    """
    # Implemented in ranking.py to keep SQL in one place.
    from app.services.ranking import build_taste_vector
    return build_taste_vector(user_id)
