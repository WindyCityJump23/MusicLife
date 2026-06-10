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


@pytest.fixture(scope="session")
def admin_client():
    """A service-role Supabase client for integration tests."""
    from supabase import create_client

    return create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_ROLE_KEY"],
    )
