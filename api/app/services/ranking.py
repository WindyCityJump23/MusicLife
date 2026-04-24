# TODO: implement the three-signal ranking queries against Supabase/pgvector.
# Functions expected by routes/recommend.py:
#   build_taste_vector(user_id: str) -> list[float]
#   rank_candidates(user_id, taste_vector, prompt_vector, weights, exclude_library, limit) -> list[dict]

def build_taste_vector(user_id: str) -> list[float]:
    raise NotImplementedError


def rank_candidates(
    user_id: str,
    taste_vector: list[float],
    prompt_vector: list[float] | None,
    weights: dict[str, float],
    exclude_library: bool,
    limit: int,
) -> list[dict]:
    raise NotImplementedError
