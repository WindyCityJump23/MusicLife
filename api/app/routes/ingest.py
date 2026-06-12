"""
Ingestion endpoints. These are heavy and run async / scheduled.
Each one is a thin wrapper; logic lives in app/services/.

TODO order (matches the week-by-week build plan):
  Week 1:  POST /ingest/spotify-library
  Week 2:  POST /ingest/enrich-artists, POST /ingest/embed-artists
  Week 3:  POST /ingest/sources
"""
import uuid

from fastapi import APIRouter, BackgroundTasks, Body, Depends
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


@router.post("/embed-tracks")
def embed_tracks(
    bg: BackgroundTasks,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
):
    """Generate embeddings for tracks (track-level context matching).

    Runs a backfill pass first to fill embedding_source for any rows
    populated before the column existed, then embeds everything still
    missing a vector.
    """
    token = require_bearer_token(credentials)
    ensure_valid_bearer_token(token)
    job_id = str(uuid.uuid4())
    create_job(job_id, "embed-tracks")
    bg.add_task(_run_embed_tracks, job_id)
    return {"status": "queued", "job_id": job_id}


def _run_embed_tracks(job_id: str):
    from app.services.track_embeddings import (
        backfill_embedding_source,
        run_track_embeddings,
    )

    update_job(job_id, JobStatus.RUNNING, "Generating track embeddings...")
    try:
        backfill = backfill_embedding_source()
        summary = run_track_embeddings()
        embedded = summary.get("embedded", 0) if isinstance(summary, dict) else 0
        skipped = summary.get("skipped", 0) if isinstance(summary, dict) else 0
        batches = summary.get("batches", 0) if isinstance(summary, dict) else 0
        backfilled = backfill.get("updated", 0) if isinstance(backfill, dict) else 0
        last_error = summary.get("last_error") if isinstance(summary, dict) else None
        msg = f"Embedded {embedded} tracks in {batches} batches"
        if backfilled:
            msg += f" (backfilled {backfilled} sources)"
        if skipped:
            msg += f" ({skipped} skipped)"
        if embedded == 0 and skipped > 0:
            reason = last_error or "no tracks were embedded"
            failure_msg = f"{msg} — embedding failed: {reason}"[:500]
            update_job(job_id, JobStatus.FAILED, failure_msg)
            print(f"embed_tracks: FAILED — {failure_msg}")
        else:
            if last_error:
                msg += f" — last error: {last_error}"
            update_job(job_id, JobStatus.SUCCESS, msg[:500])
            print(f"embed_tracks: completed — {msg}")
    except Exception as exc:
        update_job(job_id, JobStatus.FAILED, str(exc)[:500])
        print(f"embed_tracks: FAILED: {exc}")


def _summarize_track_embedding(backfill: dict | None, summary: dict | None) -> str:
    embedded = summary.get("embedded", 0) if isinstance(summary, dict) else 0
    skipped = summary.get("skipped", 0) if isinstance(summary, dict) else 0
    batches = summary.get("batches", 0) if isinstance(summary, dict) else 0
    backfilled = backfill.get("updated", 0) if isinstance(backfill, dict) else 0
    msg = f"modeled {embedded} tracks in {batches} batches"
    if backfilled:
        msg += f", prepared {backfilled} track descriptions"
    if skipped:
        msg += f" ({skipped} skipped)"
    return msg


class SourceIngestRequest(BaseModel):
    spotify_client_id: str | None = None
    spotify_client_secret: str | None = None


@router.post("/sources")
def ingest_sources(
    bg: BackgroundTasks,
    req: SourceIngestRequest = Body(default_factory=SourceIngestRequest),
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
):
    token = require_bearer_token(credentials)
    ensure_valid_bearer_token(token)
    job_id = str(uuid.uuid4())
    create_job(job_id, "sources")
    bg.add_task(
        _run_source_ingest,
        job_id,
        req.spotify_client_id,
        req.spotify_client_secret,
    )
    return {"status": "queued", "job_id": job_id}


def _coerce_int_ids(value: object) -> list[int]:
    if not isinstance(value, list):
        return []
    ids: list[int] = []
    for item in value:
        try:
            ids.append(int(item))
        except (TypeError, ValueError):
            continue
    return ids


def _run_source_ingest(
    job_id: str,
    spotify_client_id: str | None = None,
    spotify_client_secret: str | None = None,
):
    from app.services.artist_embeddings import run_artist_embeddings
    from app.services.artist_enrichment import run_artist_enrichment
    from app.services.catalog_expansion import run_catalog_expansion
    from app.services.source_ingest import run_source_ingest
    from app.services.track_embeddings import run_track_embeddings

    def progress(msg: str):
        update_job(job_id, JobStatus.RUNNING, msg[:500])

    update_job(job_id, JobStatus.RUNNING, "Crawling editorial sources...")
    try:
        summary = run_source_ingest(
            progress=progress,
            spotify_client_id=spotify_client_id,
            spotify_client_secret=spotify_client_secret,
        )
        sources = summary.get("sources_scanned", 0)
        mentions = summary.get("mentions_found", 0)
        tracks = summary.get("blog_tracks_added", 0)
        artists = summary.get("source_artists_added", 0)
        source_artist_ids = _coerce_int_ids(summary.get("source_artist_ids"))
        blog_track_ids = _coerce_int_ids(summary.get("blog_track_ids"))

        embedded_artists = 0
        embedded_tracks = 0
        followup_notes: list[str] = []

        if source_artist_ids:
            try:
                progress(f"Finalizing {len(source_artist_ids)} source artists...")
                # A small targeted enrichment pass improves genre/similar-artist
                # context without turning the daily source refresh into full setup.
                run_artist_enrichment(
                    progress=progress,
                    limit=min(25, len(source_artist_ids)),
                    artist_ids=source_artist_ids,
                )
                artist_summary = run_artist_embeddings(
                    batch_size=32,
                    progress=progress,
                    artist_ids=source_artist_ids,
                    max_total=max(32, len(source_artist_ids)),
                )
                embedded_artists = artist_summary.get("embedded", 0)
                last_error = artist_summary.get("last_error")
                if last_error:
                    followup_notes.append(f"artist embedding warning: {last_error}")
            except Exception as exc:
                followup_notes.append(f"artist finalization skipped: {exc}")
                print(f"source_ingest: artist finalization failed: {exc}")

        if blog_track_ids:
            try:
                progress(f"Finalizing {len(blog_track_ids)} source tracks...")
                track_summary = run_track_embeddings(
                    batch_size=64,
                    track_ids=blog_track_ids,
                    max_total=max(64, len(blog_track_ids)),
                    progress=progress,
                )
                embedded_tracks = track_summary.get("embedded", 0)
                last_error = track_summary.get("last_error")
                if last_error:
                    followup_notes.append(f"track embedding warning: {last_error}")
            except Exception as exc:
                followup_notes.append(f"track finalization skipped: {exc}")
                print(f"source_ingest: track finalization failed: {exc}")

        # Bounded similar-artist expansion. This avenue (Last.fm similar
        # artists) was previously only reachable via the standalone
        # /ingest/expand-catalog endpoint, which nothing called — so the
        # catalog only grew from the user's own library and blog mentions.
        # A small capped pass per refresh widens the discovery pool without
        # turning the daily refresh into a crawl. New artists are enriched
        # and embedded by the next refresh's finalization pass.
        expanded_artists = 0
        try:
            progress("Expanding catalog from similar artists...")
            expansion = run_catalog_expansion(max_seeds=20)
            expanded_artists = expansion.get("inserted", 0) if isinstance(expansion, dict) else 0
        except Exception as exc:
            followup_notes.append(f"catalog expansion skipped: {exc}")
            print(f"source_ingest: catalog expansion failed (non-fatal): {exc}")

        msg = f"Scanned {sources} sources, found {mentions} mentions"
        if tracks:
            msg += f", added {tracks} tracks"
        if artists:
            msg += f", discovered {artists} artists"
        if expanded_artists:
            msg += f", expanded {expanded_artists} similar artists"
        if embedded_artists:
            msg += f", modeled {embedded_artists} artists"
        if embedded_tracks:
            msg += f", modeled {embedded_tracks} tracks"
        if followup_notes:
            msg += f" — {'; '.join(followup_notes)}"
        update_job(job_id, JobStatus.SUCCESS, msg[:500])
        print("source_ingest: completed")
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


class StatsBackfillRequest(BaseModel):
    limit: int | None = None


@router.post("/backfill-lastfm-stats")
def backfill_lastfm_stats(
    bg: BackgroundTasks,
    req: StatsBackfillRequest = Body(default_factory=StatsBackfillRequest),
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
):
    """Fetch Last.fm listener/playcount stats for artists missing them.

    Recognizability proxy after Spotify removed popularity scores
    (see migration 028). Resumable: only NULL rows are selected.
    """
    token = require_bearer_token(credentials)
    ensure_valid_bearer_token(token)
    job_id = str(uuid.uuid4())
    create_job(job_id, "backfill-lastfm-stats")
    bg.add_task(_run_lastfm_stats_backfill, job_id, req.limit)
    return {"status": "queued", "job_id": job_id}


def _run_lastfm_stats_backfill(job_id: str, limit: int | None = None):
    from app.services.lastfm_stats_backfill import run_lastfm_stats_backfill

    update_job(job_id, JobStatus.RUNNING, "Fetching listener stats from Last.fm...")
    try:
        summary = run_lastfm_stats_backfill(
            limit=limit,
            progress=lambda msg: update_job(job_id, JobStatus.RUNNING, msg[:500]),
        )
        msg = (
            f"Listener stats: {summary.get('updated', 0)}/{summary.get('total', 0)} updated"
        )
        if summary.get("not_found"):
            msg += f", {summary['not_found']} not on Last.fm"
        if summary.get("errors"):
            msg += f" ({summary['errors']} errors)"
        update_job(job_id, JobStatus.SUCCESS, msg[:500])
        print(f"lastfm_stats_backfill: completed \u2014 {msg}")
    except Exception as exc:
        update_job(job_id, JobStatus.FAILED, str(exc)[:500])
        print(f"lastfm_stats_backfill: FAILED: {exc}")


@router.post("/backfill-release-dates")
def backfill_release_dates(
    bg: BackgroundTasks,
    req: StatsBackfillRequest = Body(default_factory=StatsBackfillRequest),
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
):
    """Fill missing track release dates from the Deezer public API.

    Strict-match only; ambiguous candidates are skipped. Resumable: only
    NULL release_date rows are selected.
    """
    token = require_bearer_token(credentials)
    ensure_valid_bearer_token(token)
    job_id = str(uuid.uuid4())
    create_job(job_id, "backfill-release-dates")
    bg.add_task(_run_deezer_release_backfill, job_id, req.limit)
    return {"status": "queued", "job_id": job_id}


def _run_deezer_release_backfill(job_id: str, limit: int | None = None):
    from app.services.deezer_release_backfill import run_deezer_release_backfill

    update_job(job_id, JobStatus.RUNNING, "Backfilling release dates from Deezer...")
    try:
        summary = run_deezer_release_backfill(
            limit=limit,
            progress=lambda msg: update_job(job_id, JobStatus.RUNNING, msg[:500]),
        )
        msg = (
            f"Release dates: {summary.get('updated', 0)}/{summary.get('total', 0)} filled"
        )
        if summary.get("skipped_ambiguous"):
            msg += f", {summary['skipped_ambiguous']} ambiguous skipped"
        if summary.get("errors"):
            msg += f" ({summary['errors']} errors)"
        update_job(job_id, JobStatus.SUCCESS, msg[:500])
        print(f"deezer_release_backfill: completed \u2014 {msg}")
    except Exception as exc:
        update_job(job_id, JobStatus.FAILED, str(exc)[:500])
        print(f"deezer_release_backfill: FAILED: {exc}")


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
    spotify_refresh_token: str | None = None
    spotify_client_id: str | None = None
    spotify_client_secret: str | None = None


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

    # Try refreshing the token immediately so we start with a fresh one
    active_token = req.spotify_access_token
    if req.spotify_refresh_token and req.spotify_client_id and req.spotify_client_secret:
        refreshed = _refresh_spotify_token(
            req.spotify_refresh_token, req.spotify_client_id, req.spotify_client_secret
        )
        if refreshed:
            active_token = refreshed

    bg.add_task(_run_populate_tracks, job_id, active_token)
    return {"status": "queued", "job_id": job_id}


def _run_populate_tracks(job_id: str, spotify_token: str):
    from app.services.track_embeddings import (
        backfill_embedding_source,
        run_track_embeddings,
    )
    from app.services.track_populator import run_track_population

    update_job(job_id, JobStatus.RUNNING, "Populating tracks for all artists...")
    try:
        summary = run_track_population(
            spotify_token,
            progress=lambda msg: update_job(job_id, JobStatus.RUNNING, msg[:500]),
        )
        added = summary.get("tracks_added", 0) if isinstance(summary, dict) else 0
        processed = summary.get("artists_processed", 0) if isinstance(summary, dict) else 0
        errors = summary.get("errors", 0) if isinstance(summary, dict) else 0
        fatal_error = summary.get("error") if isinstance(summary, dict) else None
        msg = f"Added {added} tracks for {processed} artists"
        if errors:
            msg += f" ({errors} errors)"
        last_err = summary.get("last_error") if isinstance(summary, dict) else None
        if last_err:
            msg += f" — last error: {last_err}"

        update_job(job_id, JobStatus.RUNNING, "Preparing track context...")
        backfill = backfill_embedding_source()
        update_job(job_id, JobStatus.RUNNING, "Generating track embeddings...")
        embed_summary = run_track_embeddings(
            progress=lambda embed_msg: update_job(job_id, JobStatus.RUNNING, embed_msg[:500])
        )
        embed_msg = _summarize_track_embedding(backfill, embed_summary)
        embedded = embed_summary.get("embedded", 0) if isinstance(embed_summary, dict) else 0
        skipped = embed_summary.get("skipped", 0) if isinstance(embed_summary, dict) else 0
        embed_error = embed_summary.get("last_error") if isinstance(embed_summary, dict) else None

        if fatal_error and embedded == 0:
            fail_msg = f"Failed: {fatal_error}. Track context not modeled."
            update_job(job_id, JobStatus.FAILED, fail_msg[:500])
            print(f"populate_tracks: FAILED — {fail_msg}")
        elif added == 0 and processed == 0 and embedded == 0:
            update_job(job_id, JobStatus.FAILED, msg[:500])
            print(f"populate_tracks: FAILED (0 results) — {msg}")
        elif embedded == 0 and skipped > 0:
            reason = embed_error or "no tracks were embedded"
            fail_msg = f"{msg}; embedding failed: {reason}"[:500]
            update_job(job_id, JobStatus.FAILED, fail_msg)
            print(f"populate_tracks: FAILED — {fail_msg}")
        else:
            if fatal_error:
                msg += f"; Spotify update incomplete: {fatal_error}"
            msg += f"; {embed_msg}"
            if embed_error:
                msg += f" — embedding warning: {embed_error}"
            update_job(job_id, JobStatus.SUCCESS, msg[:500])
            print(f"populate_tracks: completed — {msg}")
    except Exception as exc:
        update_job(job_id, JobStatus.FAILED, str(exc)[:500])
        print(f"populate_tracks: FAILED: {exc}")


class SetupAllRequest(BaseModel):
    user_id: str
    spotify_access_token: str
    # Optional fields for auto-refreshing the Spotify token before step 5.
    # Steps 1–4 can take >1 h for large libraries, so the initial access token
    # may be expired by the time track population starts.
    spotify_refresh_token: str | None = None
    spotify_client_id: str | None = None
    spotify_client_secret: str | None = None
    # When True, skip step 1 (Spotify library sync). Used for playlist-import
    # users whose tracks are already ingested via the import-playlist route.
    skip_spotify_sync: bool = False


def _get_client_credentials_token(client_id: str, client_secret: str) -> str | None:
    """Get a Spotify token via Client Credentials flow.

    This uses the app's own credentials (not a user token), which may have
    a separate rate limit pool from user OAuth tokens. Good for endpoints
    that don't need user context (Search, top-tracks, etc.).
    """
    import base64
    import httpx

    basic = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    try:
        resp = httpx.post(
            "https://accounts.spotify.com/api/token",
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Authorization": f"Basic {basic}",
            },
            data={"grant_type": "client_credentials"},
            timeout=15,
        )
        if resp.status_code == 200:
            token = resp.json().get("access_token")
            if token:
                print("spotify_cc: got client credentials token", flush=True)
                return token
        print(f"spotify_cc: failed HTTP {resp.status_code}", flush=True)
    except Exception as exc:
        print(f"spotify_cc: error: {exc}", flush=True)
    return None


def _refresh_spotify_token(
    refresh_token: str,
    client_id: str,
    client_secret: str,
) -> str | None:
    """Refresh a Spotify access token. Returns new token or None on failure."""
    import base64
    import httpx

    basic = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    try:
        resp = httpx.post(
            "https://accounts.spotify.com/api/token",
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Authorization": f"Basic {basic}",
            },
            data={"grant_type": "refresh_token", "refresh_token": refresh_token},
            timeout=15,
        )
        if resp.status_code == 200:
            token = resp.json().get("access_token")
            if token:
                print("spotify_refresh: successfully refreshed token")
                return token
        print(f"spotify_refresh: failed HTTP {resp.status_code}")
    except Exception as exc:
        print(f"spotify_refresh: error: {exc}")
    return None


def _chunked(items: list, size: int = 200):
    for i in range(0, len(items), size):
        yield items[i : i + size]


def _radio_readiness_message(user_id: str, ready_message: str) -> str:
    """Return a user-facing setup completion message based on actual readiness."""
    try:
        readiness = _compute_radio_readiness(user_id)
    except Exception as exc:
        print(f"setup_all: could not compute radio readiness: {exc}", flush=True)
        return ready_message

    if readiness["radio_ready"]:
        return ready_message

    missing: list[str] = []
    if readiness["artist_count"] == 0:
        missing.append("Spotify artists")
    if readiness["embedded_count"] < readiness["required_artist_count"]:
        missing.append(
            f"{readiness['required_artist_count'] - readiness['embedded_count']} more taste-modeled artists"
        )
    if readiness["playable_track_count"] < readiness["required_playable_track_count"]:
        missing.append(
            f"{readiness['required_playable_track_count'] - readiness['playable_track_count']} more playable tracks"
        )
    if not missing:
        return ready_message
    return f"Taste profile is ready. Radio needs {', '.join(missing)}."


def _compute_radio_readiness(user_id: str) -> dict:
    from app.services.supabase_client import admin_supabase

    user_tracks = (
        admin_supabase.table("user_tracks")
        .select("track_id, tracks(artist_id)")
        .eq("user_id", user_id)
        .execute()
    ).data or []

    artist_ids = sorted({
        row.get("tracks", {}).get("artist_id")
        for row in user_tracks
        if isinstance(row.get("tracks"), dict)
        and isinstance(row.get("tracks", {}).get("artist_id"), int)
    })
    artist_count = len(artist_ids)
    required_artist_count = _required_artist_count(artist_count)

    enriched_count = 0
    embedded_count = 0
    playable_track_count = 0

    for chunk in _chunked(artist_ids):
        rows = (
            admin_supabase.table("artists")
            .select("id, genres, musicbrainz_id, lastfm_url, embedding_source")
            .in_("id", chunk)
            .execute()
        ).data or []
        embedded_rows = (
            admin_supabase.table("artists")
            .select("id")
            .in_("id", chunk)
            .not_.is_("embedding", "null")
            .execute()
        ).data or []
        embedded_ids = {r["id"] for r in embedded_rows}
        for row in rows:
            genres = row.get("genres") or []
            if (
                row.get("musicbrainz_id")
                or row.get("lastfm_url")
                or row.get("embedding_source")
                or len(genres) > 0
            ):
                enriched_count += 1
            if row["id"] in embedded_ids:
                embedded_count += 1

        track_rows = (
            admin_supabase.table("tracks")
            .select("id")
            .in_("artist_id", chunk)
            .not_.is_("spotify_track_id", "null")
            .execute()
        ).data or []
        playable_track_count += len(track_rows)

    required_playable_track_count = _required_playable_track_count(artist_count, required_artist_count)
    return {
        "artist_count": artist_count,
        "enriched_count": enriched_count,
        "embedded_count": embedded_count,
        "playable_track_count": playable_track_count,
        "required_artist_count": required_artist_count,
        "required_playable_track_count": required_playable_track_count,
        "radio_ready": (
            artist_count > 0
            and enriched_count >= required_artist_count
            and embedded_count >= required_artist_count
            and playable_track_count >= required_playable_track_count
        ),
    }


def _required_artist_count(artist_count: int) -> int:
    if artist_count <= 0:
        return 0
    return min(artist_count, max(5, (artist_count + 3) // 4))


def _required_playable_track_count(artist_count: int, required_artist_count: int) -> int:
    if artist_count <= 0:
        return 0
    return min(50, max(10, required_artist_count * 3))


@router.post("/setup-all")
def setup_all(
    req: SetupAllRequest,
    bg: BackgroundTasks,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
):
    """Run the full library setup pipeline as one orchestrated job.

    Sequentially runs sync → enrich → embed artists → sources → populate
    tracks → embed tracks
    server-side, reporting unified progress via the standard /status/{job_id}
    endpoint. Progress state is persisted for dashboard polling; if the process
    loses the running task, stale status checks tell the user to re-run setup.
    """
    token = require_bearer_token(credentials)
    ensure_valid_bearer_token(token)
    job_id = str(uuid.uuid4())
    create_job(job_id, "setup-all", user_id=req.user_id, total_steps=6)
    bg.add_task(
        _run_setup_all,
        job_id,
        req.user_id,
        req.spotify_access_token,
        req.spotify_refresh_token,
        req.spotify_client_id,
        req.spotify_client_secret,
        req.skip_spotify_sync,
    )
    return {"status": "queued", "job_id": job_id}


def _run_setup_all(
    job_id: str,
    user_id: str,
    spotify_token: str,
    refresh_token: str | None = None,
    client_id: str | None = None,
    client_secret: str | None = None,
    skip_spotify_sync: bool = False,
):
    from app.services.artist_embeddings import run_artist_embeddings
    from app.services.artist_enrichment import run_artist_enrichment
    from app.services.source_ingest import run_source_ingest
    from app.services.spotify_ingest import run_spotify_library_ingest
    from app.services.track_embeddings import (
        backfill_embedding_source,
        run_track_embeddings,
    )
    from app.services.track_populator import run_track_population

    total = 6

    def progress_for(step: int):
        def cb(msg: str):
            update_job(job_id, JobStatus.RUNNING, f"Step {step}/{total}: {msg}")
        return cb

    # ── Helper: get a fresh Spotify token (or fall back to current) ────
    def fresh_token() -> str:
        """Return a refreshed Spotify access token, or the original if refresh fails."""
        nonlocal spotify_token
        if refresh_token and client_id and client_secret:
            refreshed = _refresh_spotify_token(refresh_token, client_id, client_secret)
            if refreshed:
                spotify_token = refreshed  # cache for next call
                return refreshed
        return spotify_token

    current_stage = "starting"
    try:
        # Always refresh the token at the start — the original may already
        # be expired by the time the background job picks up.
        active_token = fresh_token()
        print(f"setup_all: using token len={len(active_token)}, had refresh={'yes' if refresh_token else 'no'}", flush=True)

        current_stage = "Sync Library"
        if skip_spotify_sync:
            progress_for(1)("Playlist already imported — skipping Spotify sync")
        else:
            progress_for(1)("Syncing Spotify library…")
            run_spotify_library_ingest(user_id, active_token)

        current_stage = "Enrich Artists"
        progress_for(2)("Enriching artists…")
        run_artist_enrichment(progress=progress_for(2))

        current_stage = "Generate Embeddings"
        progress_for(3)("Generating embeddings…")
        embed_summary = run_artist_embeddings(progress=progress_for(3))
        if isinstance(embed_summary, dict):
            embedded = embed_summary.get("embedded", 0)
            skipped = embed_summary.get("skipped", 0)
            if embedded == 0 and skipped > 0:
                reason = embed_summary.get("last_error") or "no artists were embedded"
                raise RuntimeError(f"embedding failed: {reason}")

        current_stage = "Sync Sources"
        progress_for(4)("Fetching editorial sources…")
        run_source_ingest(
            progress=progress_for(4),
            spotify_client_id=client_id,
            spotify_client_secret=client_secret,
        )

        current_stage = "Populate Tracks"
        # Cool down before hitting Spotify Search — steps 1-4 may have
        # burned through the rate limit window already.
        import time as _time
        progress_for(5)("Waiting 10s for Spotify rate limit to reset…")
        _time.sleep(10)
        progress_for(5)("Populating track catalog…")
        # For track population, prefer a Client Credentials token.
        active_token = None
        if client_id and client_secret:
            active_token = _get_client_credentials_token(client_id, client_secret)
        if not active_token:
            active_token = fresh_token()

        track_added = 0
        track_catalog_note = ""

        # Step 5 is allowed to soft-fail because Spotify dev-mode rate limits
        # can lock out the app. The message must not claim Radio is ready until
        # the user's own playable track slice meets readiness.
        try:
            track_summary = run_track_population(active_token, progress=progress_for(5))
            track_error = track_summary.get("error") if isinstance(track_summary, dict) else None
            errors = track_summary.get("errors", 0) if isinstance(track_summary, dict) else 0
            added = track_summary.get("tracks_added", 0) if isinstance(track_summary, dict) else 0
            track_added = added
            if track_error:
                print(f"setup_all: track population failed (non-fatal): {track_error}", flush=True)
                track_catalog_note = f" Track catalog will update later: {track_error}"
            elif errors > 0 and added == 0:
                last_err = (track_summary.get("last_error") or "") if isinstance(track_summary, dict) else ""
                note = "rate-limited" if "429" in last_err or "rate" in last_err.lower() else "will retry later"
                track_catalog_note = f" Track catalog will update later — {note}"
        except Exception as step5_exc:
            print(f"setup_all: step 5 non-fatal error — {step5_exc}", flush=True)
            track_catalog_note = " Track catalog will update later"

        current_stage = "Model Tracks"
        model_note = ""
        try:
            progress_for(6)("Preparing track context…")
            backfill = backfill_embedding_source(max_rows=2_000, progress=progress_for(6))
            progress_for(6)("Generating track embeddings…")
            track_embed_summary = run_track_embeddings(
                max_total=2_000, progress=progress_for(6),
            )
            model_note = _summarize_track_embedding(backfill, track_embed_summary)
            track_embed_error = (
                track_embed_summary.get("last_error")
                if isinstance(track_embed_summary, dict)
                else None
            )
            if track_embed_error:
                track_catalog_note += f" Embedding warning: {track_embed_error}"
        except Exception as step6_exc:
            print(f"setup_all: step 6 non-fatal error — {step6_exc}", flush=True)
            model_note = "track modeling deferred"

        final_msg = _radio_readiness_message(
            user_id,
            f"Radio setup complete ({track_added} new tracks added{'; ' + model_note if model_note else ''})",
        )
        if track_catalog_note:
            final_msg += track_catalog_note
        update_job(job_id, JobStatus.SUCCESS, final_msg[:500])

        print(f"setup_all: completed for user {user_id}")
    except Exception as exc:
        msg = f"{current_stage} failed: {exc}"[:500]
        update_job(job_id, JobStatus.FAILED, msg)
        print(f"setup_all: FAILED for user {user_id} at stage {current_stage!r}: {exc}")


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
    return {
        "status": job.status.value,
        "message": job.message,
        "step": job.step,
        "total_steps": job.total_steps,
    }


@router.get("/status")
def latest_job_statuses(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
):
    """Get the latest job status for each kind. Used by the dashboard to
    show completion state without needing to track individual job IDs."""
    token = require_bearer_token(credentials)
    ensure_valid_bearer_token(token)
    kinds = [
        "spotify-library",
        "enrich-artists",
        "embed-artists",
        "sources",
        "populate-tracks",
        "embed-tracks",
    ]
    result = {}
    for kind in kinds:
        job = get_latest_by_kind(kind)
        if job:
            result[kind] = {"status": job.status.value, "message": job.message}
        else:
            result[kind] = None
    return result
