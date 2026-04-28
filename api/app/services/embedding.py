from __future__ import annotations

from openai import OpenAI
from voyageai import Client as VoyageClient

from app.config import settings


class _Embedder:
    """Lazy-initialised embedding client.

    Client objects are created on first use rather than at import time so that
    FastAPI can start up (and serve /health) even if the embedding provider
    keys are temporarily missing or mis-configured.
    """

    def __init__(self) -> None:
        self.provider = settings.embedding_provider.lower().strip()
        self.model = settings.embedding_model
        self.dims = settings.embedding_dims
        self._voyage: VoyageClient | None = None
        self._openai: OpenAI | None = None
        self._initialised = False

    def _ensure_init(self) -> None:
        if self._initialised:
            return
        if self.provider == "voyage":
            if not settings.voyage_api_key:
                raise RuntimeError("EMBEDDING_PROVIDER=voyage requires VOYAGE_API_KEY")
            self._voyage = VoyageClient(api_key=settings.voyage_api_key)
        elif self.provider == "openai":
            if not settings.openai_api_key:
                raise RuntimeError("EMBEDDING_PROVIDER=openai requires OPENAI_API_KEY")
            self._openai = OpenAI(api_key=settings.openai_api_key)
        else:
            raise RuntimeError(f"Unsupported EMBEDDING_PROVIDER: {self.provider!r}")
        self._initialised = True

    def embed(self, texts: list[str], input_type: str = "document") -> list[list[float]]:
        clean_texts = [t.strip() for t in texts if t and t.strip()]
        if not clean_texts:
            return []

        self._ensure_init()

        if self.provider == "voyage":
            assert self._voyage is not None
            resp = self._voyage.embed(clean_texts, model=self.model, input_type=input_type)
            return [list(v) for v in resp.embeddings]

        assert self._openai is not None
        # OpenAI API does not support voyage-style input_type.
        # Pass dimensions to constrain output to match DB schema (vector(1024)).
        # Without this, text-embedding-3-large returns 3072-d vectors that
        # silently fail or error on insert.
        resp = self._openai.embeddings.create(
            model=self.model,
            input=clean_texts,
            dimensions=self.dims,
        )
        return [list(item.embedding) for item in resp.data]


embedder = _Embedder()
