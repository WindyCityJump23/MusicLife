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
    # TODO: implement in services/spotify_ingest.py
    pass


@router.post("/enrich-artists")
def enrich_artists(bg: BackgroundTasks):
    # Walk artists with null musicbrainz_id, hit MusicBrainz + Last.fm, update.
    return {"status": "queued"}


@router.post("/embed-artists")
def embed_artists(bg: BackgroundTasks):
    # Walk artists with null embedding, build embedding_source text, embed, update.
    return {"status": "queued"}


@router.post("/sources")
def ingest_sources(bg: BackgroundTasks):
    # For each active source: fetch feed, parse posts, LLM-extract artists,
    # canonicalize, embed excerpts, insert mentions.
    return {"status": "queued"}
