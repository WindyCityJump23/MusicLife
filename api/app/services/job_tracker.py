"""
Job status tracker for background ingestion tasks.

Statuses are cached in-process for fast polling and, when a user_id is present,
persisted to Supabase so setup progress survives browser reloads and API memory
loss. The background work itself is still process-bound; stale running jobs are
marked failed so the UI can invite the user to re-run setup instead of spinning.
"""

from __future__ import annotations

import re
import time
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Optional


class JobStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"


@dataclass
class Job:
    job_id: str
    kind: str  # e.g. "spotify-library", "enrich-artists", etc.
    user_id: Optional[str] = None
    status: JobStatus = JobStatus.QUEUED
    message: str = ""
    step: int = 0
    total_steps: Optional[int] = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    finished_at: Optional[float] = None


# TTL for finished jobs (10 minutes)
_TTL_SECONDS = 600
_STALE_RUNNING_SECONDS = 60 * 60 * 2

_lock = threading.Lock()
_jobs: dict[str, Job] = {}
_STEP_RE = re.compile(r"^Step\s+(\d+)/(\d+):", re.IGNORECASE)


def create_job(
    job_id: str,
    kind: str,
    *,
    user_id: str | None = None,
    total_steps: int | None = None,
) -> Job:
    """Register a new job. Returns the Job object."""
    job = Job(job_id=job_id, kind=kind, user_id=user_id, total_steps=total_steps)
    with _lock:
        _cleanup_expired()
        _jobs[job_id] = job
    _persist_job(job)
    return job


def update_job(job_id: str, status: JobStatus, message: str = "") -> None:
    """Update a job's status and message."""
    step, total_steps = _parse_step(message)
    with _lock:
        job = _jobs.get(job_id)
        if job:
            job.status = status
            job.message = message
            job.updated_at = time.time()
            if step is not None:
                job.step = step
            if total_steps is not None:
                job.total_steps = total_steps
            if status in (JobStatus.SUCCESS, JobStatus.FAILED):
                job.finished_at = time.time()
        else:
            job = _fetch_persisted_job(job_id)
            if job:
                job.status = status
                job.message = message
                job.updated_at = time.time()
                if step is not None:
                    job.step = step
                if total_steps is not None:
                    job.total_steps = total_steps
                if status in (JobStatus.SUCCESS, JobStatus.FAILED):
                    job.finished_at = time.time()
                _jobs[job_id] = job
    if job:
        _persist_job(job)


def get_job(job_id: str) -> Optional[Job]:
    """Get a job by ID."""
    with _lock:
        job = _jobs.get(job_id)
    if not job:
        job = _fetch_persisted_job(job_id)
        if job:
            with _lock:
                _jobs[job_id] = job
    if job and _is_stale_running(job):
        update_job(
            job.job_id,
            JobStatus.FAILED,
            "Setup stopped before finishing. Re-run setup to continue.",
        )
        job = _jobs.get(job_id)
    return job


def get_latest_by_kind(kind: str) -> Optional[Job]:
    """Get the most recent job of a given kind."""
    with _lock:
        matches = [j for j in _jobs.values() if j.kind == kind]
        if not matches:
            return None
        return max(matches, key=lambda j: j.created_at)


def _cleanup_expired() -> None:
    """Remove finished jobs older than TTL. Called under lock."""
    now = time.time()
    expired = [
        jid
        for jid, job in _jobs.items()
        if job.finished_at is not None and (now - job.finished_at) > _TTL_SECONDS
    ]
    for jid in expired:
        del _jobs[jid]


def _parse_step(message: str) -> tuple[int | None, int | None]:
    match = _STEP_RE.match(message or "")
    if not match:
        return None, None
    return int(match.group(1)), int(match.group(2))


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _persist_job(job: Job) -> None:
    if not job.user_id:
        return
    try:
        from app.services.supabase_client import admin_supabase

        row = {
            "id": job.job_id,
            "user_id": job.user_id,
            "kind": job.kind,
            "status": job.status.value,
            "step": job.step,
            "total_steps": job.total_steps,
            "message": job.message,
            "updated_at": _now_iso(),
            "finished_at": (
                datetime.fromtimestamp(job.finished_at, timezone.utc).isoformat()
                if job.finished_at
                else None
            ),
        }
        admin_supabase.table("setup_jobs").upsert(row, on_conflict="id").execute()
    except Exception as exc:
        print(f"job_tracker: could not persist job {job.job_id}: {exc}", flush=True)


def _fetch_persisted_job(job_id: str) -> Optional[Job]:
    try:
        from app.services.supabase_client import admin_supabase

        result = (
            admin_supabase.table("setup_jobs")
            .select("id, user_id, kind, status, step, total_steps, message, created_at, updated_at, finished_at")
            .eq("id", job_id)
            .limit(1)
            .execute()
        )
        rows = result.data or []
        if not rows:
            return None
        row = rows[0]
        created = _parse_db_time(row.get("created_at")) or time.time()
        updated = _parse_db_time(row.get("updated_at")) or created
        finished = _parse_db_time(row.get("finished_at"))
        try:
            status = JobStatus(row.get("status") or JobStatus.QUEUED.value)
        except ValueError:
            status = JobStatus.QUEUED
        return Job(
            job_id=row["id"],
            kind=row["kind"],
            user_id=row.get("user_id"),
            status=status,
            message=row.get("message") or "",
            step=row.get("step") or 0,
            total_steps=row.get("total_steps"),
            created_at=created,
            updated_at=updated,
            finished_at=finished,
        )
    except Exception as exc:
        print(f"job_tracker: could not fetch persisted job {job_id}: {exc}", flush=True)
        return None


def _parse_db_time(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _is_stale_running(job: Job) -> bool:
    if job.status not in (JobStatus.QUEUED, JobStatus.RUNNING):
        return False
    return (time.time() - job.updated_at) > _STALE_RUNNING_SECONDS
