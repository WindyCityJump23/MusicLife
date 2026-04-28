"""
Ingestion endpoints. These are heavy and run async / scheduled.
Each one is a thin wrapper; logic lives in app/services/.

TODO order (matches the week-by-week build plan):
  Week 1:  POST /ingest/spotify-library
  Week 2:  POST /ingest/enrich-artists, POST /ingest/embed-artists
  Week 3:  POST /ingest/sources
"""
from fastapi import APIRouter, BackgroundTasks
from pydantic import BaseModel

router = APIRouter()


class SpotifyLibraryRequest(BaseModel):
    user_id: str
    spotify_access_token: str


@router.post("/spotify-library")
def ingest_spotify_library(req: SpotifyLibraryRequest, bg: BackgroundTasks):
    # Pull saved tracks, top artists, recent plays. Upsert artists and tracks,
    # insert listens. Implementation: app/services/spotify_ingest.py
    bg.add_task(_run_spotify_ingest, req.user_id, req.spotify_access_token)
    return {"status": "queued"}


def _run_spotify_ingest(user_id: str, token: str):
    from app.services.spotify_ingest import run_spotify_library_ingest

    try:
        run_spotify_library_ingest(user_id, token)
        print(f"spotify_ingest: completed for user {user_id}")
    except Exception as exc:
        print(f"spotify_ingest: FAILED for user {user_id}: {exc}")


@router.post("/enrich-artists")
def enrich_artists(bg: BackgroundTasks):
    bg.add_task(_run_enrich_artists)
    return {"status": "queued"}


def _run_enrich_artists():
    from app.services.artist_enrichment import run_artist_enrichment

    try:
        run_artist_enrichment()
    except Exception as exc:
        print(f"enrich_artists: FAILED: {exc}")


@router.post("/embed-artists")
def embed_artists(bg: BackgroundTasks):
    bg.add_task(_run_embed_artists)
    return {"status": "queued"}


def _run_embed_artists():
    from app.services.artist_embeddings import run_artist_embeddings

    try:
        run_artist_embeddings()
    except Exception as exc:
        print(f"embed_artists: FAILED: {exc}")


@router.post("/sources")
def ingest_sources(bg: BackgroundTasks):
    # For each active source: fetch feed, parse posts, match artists,
    # embed excerpts, insert mentions. Implementation: app/services/source_ingest.py
    bg.add_task(_run_source_ingest)
    return {"status": "queued"}


def _run_source_ingest():
    from app.services.source_ingest import run_source_ingest

    try:
        run_source_ingest()
    except Exception as exc:
        print(f"source_ingest: FAILED: {exc}")
