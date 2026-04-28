"""
Simple in-memory job status tracker for background ingestion tasks.

This is intentionally lightweight — no persistence, no Redis. If the API
process restarts, in-flight jobs are lost. That's fine for a personal app
where the user can just re-trigger.

Jobs auto-expire after 10 minutes to avoid unbounded memory growth.
"""

from __future__ import annotations

import time
import threading
from dataclasses import dataclass, field
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
    status: JobStatus = JobStatus.QUEUED
    message: str = ""
    created_at: float = field(default_factory=time.time)
    finished_at: Optional[float] = None


# TTL for finished jobs (10 minutes)
_TTL_SECONDS = 600

_lock = threading.Lock()
_jobs: dict[str, Job] = {}


def create_job(job_id: str, kind: str) -> Job:
    """Register a new job. Returns the Job object."""
    job = Job(job_id=job_id, kind=kind)
    with _lock:
        _cleanup_expired()
        _jobs[job_id] = job
    return job


def update_job(job_id: str, status: JobStatus, message: str = "") -> None:
    """Update a job's status and message."""
    with _lock:
        job = _jobs.get(job_id)
        if job:
            job.status = status
            job.message = message
            if status in (JobStatus.SUCCESS, JobStatus.FAILED):
                job.finished_at = time.time()


def get_job(job_id: str) -> Optional[Job]:
    """Get a job by ID."""
    with _lock:
        return _jobs.get(job_id)


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
