"""Lightweight in-process token-bucket rate limiter.

The recommendation path is expensive (a candidate pull plus up to five full
re-rank attempts), so an authenticated user can hammer it. This caps per-user
request rate without an external dependency.

Scope note: state is per-process, so on a multi-instance deployment each
instance enforces the limit independently. That is acceptable as a first line
of abuse defense on the current single-instance Render backend; a distributed
limiter (Redis) is the scale-out path and is documented in
docs/PRODUCTION_ROADMAP.md.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass


@dataclass
class _Bucket:
    tokens: float
    last_refill: float


class TokenBucketRateLimiter:
    """Classic token bucket: ``capacity`` tokens, refilled at ``refill_per_sec``.

    Each ``allow(key)`` consumes one token when available. Buckets are created
    lazily per key and idle buckets are swept so memory stays bounded.
    """

    def __init__(self, capacity: int, refill_per_sec: float, *, idle_ttl_sec: float = 600.0):
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        if refill_per_sec <= 0:
            raise ValueError("refill_per_sec must be positive")
        self.capacity = float(capacity)
        self.refill_per_sec = float(refill_per_sec)
        self.idle_ttl_sec = idle_ttl_sec
        self._buckets: dict[str, _Bucket] = {}
        self._lock = threading.Lock()
        self._last_sweep = time.monotonic()

    def _sweep(self, now: float) -> None:
        if now - self._last_sweep < self.idle_ttl_sec:
            return
        stale = [
            key
            for key, bucket in self._buckets.items()
            if now - bucket.last_refill > self.idle_ttl_sec
        ]
        for key in stale:
            del self._buckets[key]
        self._last_sweep = now

    def allow(self, key: str) -> bool:
        """Consume one token for ``key``. Returns False when the bucket is empty."""
        now = time.monotonic()
        with self._lock:
            self._sweep(now)
            bucket = self._buckets.get(key)
            if bucket is None:
                # New keys start full, minus the token this call consumes.
                self._buckets[key] = _Bucket(tokens=self.capacity - 1.0, last_refill=now)
                return True
            elapsed = now - bucket.last_refill
            bucket.tokens = min(self.capacity, bucket.tokens + elapsed * self.refill_per_sec)
            bucket.last_refill = now
            if bucket.tokens >= 1.0:
                bucket.tokens -= 1.0
                return True
            return False

    def retry_after_seconds(self, key: str) -> int:
        """Seconds until at least one token is available for ``key``."""
        with self._lock:
            bucket = self._buckets.get(key)
            if bucket is None or bucket.tokens >= 1.0:
                return 0
            deficit = 1.0 - bucket.tokens
            return max(1, int(deficit / self.refill_per_sec + 0.999))


# Default limiter for the recommendation endpoints: a burst of 30 with steady
# refill of one request every two seconds (~30/min sustained).
recommend_limiter = TokenBucketRateLimiter(capacity=30, refill_per_sec=0.5)
