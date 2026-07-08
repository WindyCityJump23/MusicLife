"""Pressure tests for transient-infrastructure resilience.

Simulates the June 2026 outage class (paused Supabase project -> hostname
drops off DNS -> '[Errno -2] Name or service not known') plus dropped
connections, 429s, and 5xx across the retry layers, and verifies users see
actionable copy instead of raw OS errors.
"""

import time as _time

import httpx
import pytest

from app.services.error_copy import (
    FRIENDLY_TRANSIENT_MESSAGE,
    friendly_error_message,
    is_transient_infra_error,
)
from app.services.spotify_ingest import _get_with_retry
from app.services.supabase_client import retry_on_disconnect


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    """Retries must back off in prod but tests should not wait."""
    monkeypatch.setattr(_time, "sleep", lambda *_: None)
    yield


def _dns_error() -> httpx.ConnectError:
    # httpx wraps socket.gaierror; the str() is what users previously saw.
    return httpx.ConnectError("[Errno -2] Name or service not known")


# ── error_copy ──────────────────────────────────────────────────────────


class TestFriendlyErrorCopy:
    def test_dns_failure_maps_to_friendly_copy(self):
        assert friendly_error_message(_dns_error()) == FRIENDLY_TRANSIENT_MESSAGE

    def test_gaierror_variants_detected(self):
        for text in (
            "[Errno -3] Temporary failure in name resolution",
            "Connection refused",
            "The read operation timed out",
            "Server disconnected without sending a response.",
        ):
            assert is_transient_infra_error(RuntimeError(text)), text

    def test_wrapped_cause_chain_detected(self):
        try:
            try:
                raise _dns_error()
            except httpx.ConnectError as inner:
                raise RuntimeError("library sync failed") from inner
        except RuntimeError as outer:
            assert is_transient_infra_error(outer)
            assert friendly_error_message(outer) == FRIENDLY_TRANSIENT_MESSAGE

    def test_real_errors_pass_through_unchanged(self):
        exc = RuntimeError("Spotify token is expired or missing required permissions.")
        assert not is_transient_infra_error(exc)
        assert friendly_error_message(exc) == str(exc)

    def test_cycle_in_context_chain_terminates(self):
        a = RuntimeError("a")
        b = RuntimeError("b")
        a.__context__ = b
        b.__context__ = a  # pathological cycle
        assert not is_transient_infra_error(a)


# ── retry_on_disconnect (Supabase layer) ────────────────────────────────


class TestRetryOnDisconnect:
    def test_recovers_from_dns_blip(self):
        calls = {"n": 0}

        def flaky():
            calls["n"] += 1
            if calls["n"] < 3:
                raise _dns_error()
            return "ok"

        assert retry_on_disconnect(flaky, attempts=3) == "ok"
        assert calls["n"] == 3

    def test_gives_up_after_bounded_attempts(self):
        calls = {"n": 0}

        def always_down():
            calls["n"] += 1
            raise _dns_error()

        with pytest.raises(httpx.ConnectError):
            retry_on_disconnect(always_down, attempts=3)
        assert calls["n"] == 3

    def test_non_transient_errors_propagate_immediately(self):
        calls = {"n": 0}

        def broken():
            calls["n"] += 1
            raise ValueError("bad data")

        with pytest.raises(ValueError):
            retry_on_disconnect(broken, attempts=3)
        assert calls["n"] == 1

    def test_still_covers_stale_keepalive(self):
        calls = {"n": 0}

        def stale_then_ok():
            calls["n"] += 1
            if calls["n"] == 1:
                raise httpx.RemoteProtocolError("Server disconnected")
            return 42

        assert retry_on_disconnect(stale_then_ok, attempts=2) == 42


# ── Spotify fetch retry ─────────────────────────────────────────────────


class _FakeResponse:
    def __init__(self, status_code: int, headers: dict | None = None):
        self.status_code = status_code
        self.headers = headers or {}


class _FakeClient:
    """Yields scripted outcomes per get(); exceptions are raised, others returned."""

    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = 0

    def get(self, url, headers=None, params=None):
        self.calls += 1
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


class TestSpotifyGetWithRetry:
    def test_dns_blip_then_success(self):
        client = _FakeClient([_dns_error(), _FakeResponse(200)])
        resp = _get_with_retry(client, "https://api.spotify.com/v1/me/tracks", headers={})
        assert resp.status_code == 200
        assert client.calls == 2

    def test_persistent_dns_failure_raises_after_three_attempts(self):
        client = _FakeClient([_dns_error(), _dns_error(), _dns_error()])
        with pytest.raises(httpx.ConnectError):
            _get_with_retry(client, "https://api.spotify.com/v1/me/tracks", headers={})
        assert client.calls == 3

    def test_429_honors_retry_after_then_succeeds(self, monkeypatch):
        waited: list[float] = []
        monkeypatch.setattr(_time, "sleep", lambda s: waited.append(s))
        client = _FakeClient([
            _FakeResponse(429, {"Retry-After": "7"}),
            _FakeResponse(200),
        ])
        resp = _get_with_retry(client, "https://api.spotify.com/v1/me/tracks", headers={})
        assert resp.status_code == 200
        assert 7 in waited

    def test_retry_after_is_capped(self, monkeypatch):
        waited: list[float] = []
        monkeypatch.setattr(_time, "sleep", lambda s: waited.append(s))
        client = _FakeClient([
            _FakeResponse(429, {"Retry-After": "86400"}),  # a day — never block that long
            _FakeResponse(200),
        ])
        _get_with_retry(client, "https://api.spotify.com/v1/me/tracks", headers={})
        assert max(waited) <= 30

    def test_5xx_retried_then_final_returned(self):
        client = _FakeClient([_FakeResponse(502), _FakeResponse(200)])
        resp = _get_with_retry(client, "https://api.spotify.com/v1/me/tracks", headers={})
        assert resp.status_code == 200

    def test_4xx_not_retried(self):
        client = _FakeClient([_FakeResponse(401)])
        resp = _get_with_retry(client, "https://api.spotify.com/v1/me/tracks", headers={})
        assert resp.status_code == 401
        assert client.calls == 1
