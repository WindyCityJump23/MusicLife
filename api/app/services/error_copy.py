"""Translate infrastructure exceptions into copy a listener can act on.

Setup jobs surface their failure message directly in the dashboard. Before
this existed, a paused Supabase project (its hostname drops off DNS) showed
users "Sync Library failed: [Errno -2] Name or service not known" — accurate
for an SRE, gibberish for a listener. Map connection-class failures to a
retry-in-a-minute message; anything unrecognized passes through unchanged so
real errors stay diagnosable.
"""

from __future__ import annotations

_TRANSIENT_MARKERS = (
    "name or service not known",       # gaierror -2: DNS resolution failed
    "temporary failure in name resolution",  # gaierror -3
    "nodename nor servname provided",  # macOS gaierror
    "connection refused",
    "connection reset",
    "connect timeout",
    "connecttimeout",
    "read timeout",
    "readtimeout",
    "timed out",
    "server disconnected",
    "remoteprotocolerror",
    "all connection attempts failed",
)

FRIENDLY_TRANSIENT_MESSAGE = (
    "MusicLife's music database was temporarily unreachable. "
    "It usually recovers within a minute or two — please try again."
)


def is_transient_infra_error(exc: BaseException) -> bool:
    """True when the exception (or its causes) looks like a network blip."""
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        text = f"{type(current).__name__}: {current}".lower()
        if any(marker in text for marker in _TRANSIENT_MARKERS):
            return True
        current = current.__cause__ or current.__context__
    return False


def friendly_error_message(exc: BaseException) -> str:
    """User-facing message for a failed job step."""
    if is_transient_infra_error(exc):
        return FRIENDLY_TRANSIENT_MESSAGE
    return str(exc)
