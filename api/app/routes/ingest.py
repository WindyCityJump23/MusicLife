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

    update_job(job_id, JobStatus.RUNNING, "Generating artist embeddings (processing all artists)...")
    try:
        summary = run_artist_embeddings()
        embedded = summary.get("embedded", 0) if isinstance(summary, dict) else 0
        skipped = summary.get("skipped", 0) if isinstance(summary, dict) else 0
        batches = summary.get("batches", 0) if isinstance(summary, dict) else 0
        last_error = summary.get("last_error") if isinstance(summary, dict) else None
        msg = f"Embedded {embedded} artists in {batches} batches"
        if skipped > 0:
            msg += f" ({skipped} skipped)"
        # If nothing was embedded but we tried, treat it as a failure so the
        # dashboard surfaces the underlying problem (usually a missing or
        # invalid VOYAGE_API_KEY / OPENAI_API_KEY) instead of a green check.
        if embedded == 0 and skipped > 0:
            reason = last_error or "no artists were embedded"
            failure_msg = f"{msg} — embedding failed: {reason}"[:500]
            update_job(job_id, JobStatus.FAILED, failure_msg)
            print(f"embed_artists: FAILED — {failure_msg}")
        else:
            if last_error:
                msg += f" — last error: {last_error}"
            update_job(job_id, JobStatus.SUCCESS, msg[:500])
            print(f"embed_artists: completed — {msg}")
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
        result = run_source_ingest() or {}
        message = (result.get("summary") or "Sources ingested")[:500]
        update_job(job_id, JobStatus.SUCCESS, message)
        print(f"source_ingest: completed — {message}")
    except Exception as exc:
        update_job(job_id, JobStatus.FAILED, str(exc)[:500])
        print(f"source_ingest: FAILED: {exc}")


@router.post("/backfill-genres")
def backfill_genres(
    bg: BackgroundTasks,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
):
    """Fetch Last.fm tags as genres for all artists with empty genres."""
    token = require_bearer_token(credentials)
    ensure_valid_bearer_token(token)
    job_id = str(uuid.uuid4())
    create_job(job_id, "backfill-genres")
    bg.add_task(_run_genre_backfill, job_id)
    return {"status": "queued", "job_id": job_id}


def _run_genre_backfill(job_id: str):
    from app.services.genre_backfill import run_genre_backfill

    update_job(job_id, JobStatus.RUNNING, "Fetching genres from Last.fm...")
    try:
        summary = run_genre_backfill()
        updated = summary.get("updated", 0)
        total = summary.get("total", 0)
        msg = f"Updated genres for {updated}/{total} artists"
        errs = summary.get("errors", 0)
        if errs:
            msg += f" ({errs} errors)"
        update_job(job_id, JobStatus.SUCCESS, msg[:500])
        print(f"genre_backfill: completed \u2014 {msg}")
    except Exception as exc:
        update_job(job_id, JobStatus.FAILED, str(exc)[:500])
        print(f"genre_backfill: FAILED: {exc}")


@router.post("/expand-catalog")
def expand_catalog(
    bg: BackgroundTasks,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
):
    """Expand the artist catalog via Last.fm similar artists.

    For each existing artist, fetches similar artists and adds them to the DB.
    Run enrichment + embedding + populate-tracks afterward to complete the pipeline.
    """
    token = require_bearer_token(credentials)
    ensure_valid_bearer_token(token)
    job_id = str(uuid.uuid4())
    create_job(job_id, "expand-catalog")
    bg.add_task(_run_expand_catalog, job_id)
    return {"status": "queued", "job_id": job_id}


def _run_expand_catalog(job_id: str):
    from app.services.catalog_expansion import run_catalog_expansion

    update_job(job_id, JobStatus.RUNNING, "Expanding catalog via Last.fm similar artists...")
    try:
        summary = run_catalog_expansion()
        new = summary.get("inserted", 0)
        found = summary.get("new_artists_found", 0)
        seeds = summary.get("seeds", 0)
        msg = f"Found {found} new artists from {seeds} seeds, inserted {new}"
        errs = summary.get("errors", 0)
        if errs:
            msg += f" ({errs} errors)"
        update_job(job_id, JobStatus.SUCCESS, msg[:500])
        print(f"expand_catalog: completed \u2014 {msg}")
    except Exception as exc:
        update_job(job_id, JobStatus.FAILED, str(exc)[:500])
        print(f"expand_catalog: FAILED: {exc}")


class PopulateTracksRequest(BaseModel):
    spotify_access_token: str


@router.post("/populate-tracks")
def populate_tracks(
    req: PopulateTracksRequest,
    bg: BackgroundTasks,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
):
    """Populate the tracks table for all artists using Spotify Search API.

    This fetches top tracks for artists that have few/no tracks in the DB,
    using the Search API (which works in dev mode, unlike top-tracks).
    """
    token = require_bearer_token(credentials)
    ensure_valid_bearer_token(token)
    job_id = str(uuid.uuid4())
    create_job(job_id, "populate-tracks")
    bg.add_task(_run_populate_tracks, job_id, req.spotify_access_token)
    return {"status": "queued", "job_id": job_id}


def _run_populate_tracks(job_id: str, spotify_token: str):
    from app.services.track_populator import run_track_population

    update_job(job_id, JobStatus.RUNNING, "Populating tracks for all artists...")
    try:
        summary = run_track_population(spotify_token)
        added = summary.get("tracks_added", 0)
        processed = summary.get("artists_processed", 0)
        skipped_wrong = summary.get("tracks_skipped_wrong_artist", 0)
        http_failures = summary.get("http_failures", 0)
        errors = summary.get("errors", 0)
        aborted = summary.get("aborted", False)

        msg = f"Added {added} tracks for {processed} artists"
        if skipped_wrong:
            msg += f" — skipped {skipped_wrong} wrong-artist results"
        if http_failures:
            msg += f", {http_failures} HTTP failures"
        if errors:
            msg += f", {errors} errors"

        if aborted:
            reason = summary.get("abort_reason") or summary.get("last_error") or "unknown"
            update_job(job_id, JobStatus.FAILED, f"{msg} — aborted: {reason}"[:500])
            print(f"populate_tracks: aborted — {msg} ({reason})")
            return

        last_err = summary.get("last_error")
        if last_err and (http_failures or errors):
            msg += f" — last error: {last_err}"
        update_job(job_id, JobStatus.SUCCESS, msg[:500])
        print(f"populate_tracks: completed — {msg}")
    except Exception as exc:
        update_job(job_id, JobStatus.FAILED, str(exc)[:500])
        print(f"populate_tracks: FAILED: {exc}")


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
    kinds = ["spotify-library", "enrich-artists", "embed-artists", "sources", "populate-tracks"]
    result = {}
    for kind in kinds:
        job = get_latest_by_kind(kind)
        if job:
            result[kind] = {"status": job.status.value, "message": job.message}
        else:
            result[kind] = None
    return result
