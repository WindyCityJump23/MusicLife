"""
Music Dashboard API.

Endpoints:
  POST /ingest/spotify-library   — pull user's Spotify library + listens
  POST /ingest/enrich-artists    — MusicBrainz + Last.fm enrichment
  POST /ingest/embed-artists     — generate artist embeddings
  POST /ingest/sources           — pull RSS + Reddit + extract mentions
  POST /recommend                — run the taste model, return ranked artists
  POST /synthesize               — Claude writes the "why this" paragraph

Run: uvicorn app.main:app --reload
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routes import ingest, recommend, synthesize

app = FastAPI(title="Music Dashboard API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(ingest.router, prefix="/ingest", tags=["ingest"])
app.include_router(recommend.router, prefix="/recommend", tags=["recommend"])
app.include_router(synthesize.router, prefix="/synthesize", tags=["synthesize"])


@app.get("/health")
def health():
    return {"ok": True}
