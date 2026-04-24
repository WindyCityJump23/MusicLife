from __future__ import annotations

from openai import OpenAI
from voyageai import Client as VoyageClient

from app.config import settings


class _Embedder:
    def __init__(self):
        self.provider = settings.embedding_provider.lower().strip()
        self.model = settings.embedding_model
        self._voyage: VoyageClient | None = None
        self._openai: OpenAI | None = None

        if self.provider == "voyage":
            if not settings.voyage_api_key:
                raise RuntimeError("EMBEDDING_PROVIDER=voyage requires VOYAGE_API_KEY")
            self._voyage = VoyageClient(api_key=settings.voyage_api_key)
        elif self.provider == "openai":
            if not settings.openai_api_key:
                raise RuntimeError("EMBEDDING_PROVIDER=openai requires OPENAI_API_KEY")
            self._openai = OpenAI(api_key=settings.openai_api_key)
        else:
            raise RuntimeError(f"Unsupported EMBEDDING_PROVIDER: {self.provider}")

    def embed(self, texts: list[str], input_type: str = "document") -> list[list[float]]:
        clean_texts = [t.strip() for t in texts if t and t.strip()]
        if not clean_texts:
            return []

        if self.provider == "voyage":
            assert self._voyage is not None
            resp = self._voyage.embed(clean_texts, model=self.model, input_type=input_type)
            return [list(v) for v in resp.embeddings]

        assert self._openai is not None
        # OpenAI API does not support voyage-style input_type.
        resp = self._openai.embeddings.create(model=self.model, input=clean_texts)
        return [list(item.embedding) for item in resp.data]


embedder = _Embedder()
