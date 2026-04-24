from app.config import settings

# TODO: implement Voyage AI / OpenAI embedding wrapper.
# Interface used by routes:
#   embedder.embed(texts: list[str], input_type: str) -> list[list[float]]

class _Embedder:
    def embed(self, texts: list[str], input_type: str = "document") -> list[list[float]]:
        raise NotImplementedError("Embedding service not yet implemented")


embedder = _Embedder()
