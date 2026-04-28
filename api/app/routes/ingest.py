"""
Ingestion endpoints. These are heavy and run async / scheduled.
Each one is a thin wrapper; logic lives in app/services/.

TODO order (matches the week-by-week build plan):
  Week 1:  POST /ingest/spotify-library
  Week 2:  POST /ingest/enrich-artists, POST /ingest/embed-artists
  Week 3:  POST /ingest/sources
"""
import uuid

from fastapi import APIRouter, BackgroundTasks, Depends
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel

from app.deps.auth import bearer_scheme, ensure_valid_bearer_token, require_bearer_token
from app.services.job_tracker import (
    JobStatus,
    create_job,
    get_job,
    get_latest_by_kind,
    update_job,
)

router = APIRouter()


class SpotifyLibraryRequest(BaseModel):
    user_id: str
    spotify_access_token: str


@router.post("/spotify-library")
def ingest_spotify_library(
    req: SpotifyLibraryRequest,
    bg: BackgroundTasks,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
):
    token = require_bearer_token(credentials)
    ensure_valid_bearer_token(token)
    job_id = str(uuid.uuid4())
    create_job(job_id, "spotify-library")
    bg.add_task(_run_spotify_ingest, job_id, req.user_id, req.spotify_access_token)
    return {"status": "queued", "job_id": job_id}


def _run_spotify_ingest(job_id: str, user_id: str, token: str):
    from app.services.spotify_ingest import run_spotify_library_ingest

    update_job(job_id, JobStatus.RUNNING, "Fetching Spotify library...")
    try:
        run_spotify_library_ingest(user_id, token)
        update_job(job_id, JobStatus.SUCCESS, "Library synced successfully")
        print(f"spotify_ingest: completed for user {user_id}")
    except Exception as exc:
        update_job(job_id, JobStatus.FAILED, str(exc)[:500])
        print(f"spotify_ingest: FAILED for user {user_id}: {exc}")


@router.post("/enrich-artists")
def enrich_artists(
    bg: BackgroundTasks,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
):
    token = require_bearer_token(credentials)
    ensure_valid_bearer_token(token)
    job_id = str(uuid.uuid4())
    create_job(job_id, "enrich-artists")
    bg.add_task(_run_enrich_artists, job_id)
    return {"status": "queued", "job_id": job_id}


def _run_enrich_artists(job_id: str):
    from app.services.artist_enrichment import run_artist_enrichment

    update_job(job_id, JobStatus.RUNNING, "Enriching artists via MusicBrainz + Last.fm...")
    try:
        run_artist_enrichment()
        update_job(job_id, JobStatus.SUCCESS, "Artist enrichment complete")
        print("enrich_artists: completed")
    except Exception as exc:
        update_job(job_id, JobStatus.FAILED, str(exc)[:500])
        print(f"enrich_artists: FAILED: {exc}")


@router.post("/embed-artists")
def embed_artists(
    bg: BackgroundTasks,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
):
    token = require_bearer_token(credentials)
    ensure_valid_bearer_token(token)
    job_id = str(uuid.uuid4())
    create_job(job_id, "embed-artists")
    bg.add_task(_run_embed_artists, job_id)
    return {"status": "queued", "job_id": job_id}


def _run_embed_artists(job_id: str):
    from app.services.artist_embeddings import run_artist_embeddings

    update_job(job_id, JobStatus.RUNNING, "Generating artist embeddings...")
    try:
        run_artist_embeddings()
        update_job(job_id, JobStatus.SUCCESS, "Embeddings generated")
        print("embed_artists: completed")
    except Exception as exc:
        update_job(job_id, JobStatus.FAILED, str(exc)[:500])
        print(f"embed_artists: FAILED: {exc}")


@router.post("/sources")
def ingest_sources(
    bg: BackgroundTasks,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
):
    token = require_bearer_token(credentials)
    ensure_valid_bearer_token(token)
    job_id = str(uuid.uuid4())
    create_job(job_id, "sources")
    bg.add_task(_run_source_ingest, job_id)
    return {"status": "queued", "job_id": job_id}


def _run_source_ingest(job_id: str):
    from app.services.source_ingest import run_source_ingest

    update_job(job_id, JobStatus.RUNNING, "Crawling editorial sources...")
    try:
        run_source_ingest()
        update_job(job_id, JobStatus.SUCCESS, "Sources ingested")
        print("source_ingest: completed")
    except Exception as exc:
        update_job(job_id, JobStatus.FAILED, str(exc)[:500])
        print(f"source_ingest: FAILED: {exc}")


@router.get("/status/{job_id}")
def job_status(
    job_id: str,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
):
    """Poll a specific job by ID."""
    token = require_bearer_token(credentials)
    ensure_valid_bearer_token(token)
    job = get_job(job_id)
    if not job:
        return {"status": "unknown", "message": "Job not found or expired"}
    return {"status": job.status.value, "message": job.message}


@router.get("/status")
def latest_job_statuses(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
):
    """Get the latest job status for each kind. Used by the dashboard to
    show completion state without needing to track individual job IDs."""
    token = require_bearer_token(credentials)
    ensure_valid_bearer_token(token)
    kinds = ["spotify-library", "enrich-artists", "embed-artists", "sources"]
    result = {}
    for kind in kinds:
        job = get_latest_by_kind(kind)
        if job:
            result[kind] = {"status": job.status.value, "message": job.message}
        else:
            result[kind] = None
    return result
