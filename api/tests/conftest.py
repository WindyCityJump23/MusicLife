"""Shared pytest fixtures.

Most tests here are pure and need no fixtures. The integration tests
(test_tenant_isolation) require a real Supabase project and are skipped unless
SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set in the environment.
"""

import os

import pytest


def _supabase_configured() -> bool:
    return bool(os.environ.get("SUPABASE_URL") and os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))


requires_supabase = pytest.mark.skipif(
    not _supabase_configured(),
    reason="SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set; skipping integration test",
)

# Some service modules construct app.config.Settings() at import time, which
# raises when env vars are missing. Stub the required values so unit tests can
# import those modules without real credentials. This runs AFTER the
# integration-test gate above, so stubs never un-skip real-Supabase tests.
os.environ.setdefault("SUPABASE_URL", "http://stub.local")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub-service-role-key")
os.environ.setdefault("SUPABASE_ANON_KEY", "stub-anon-key")
os.environ.setdefault("LASTFM_API_KEY", "stub-lastfm-key")


@pytest.fixture(scope="session")
def admin_client():
    """A service-role Supabase client for integration tests."""
    from supabase import create_client

    return create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_ROLE_KEY"],
    )
