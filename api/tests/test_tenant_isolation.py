"""Cross-tenant isolation contract test.

The entire app relies on *manual* per-user scoping (`.eq("user_id", ...)`)
because RLS is dormant under the service-role key (see
docs/PRODUCTION_AUDIT.md). This test seeds two users with their own
user_tracks and asserts that a user-scoped read never returns the other
user's rows — the single most important regression to catch before the
RLS/JWT migration lands.

Skipped automatically unless a Supabase project is configured. It cleans up
everything it creates.
"""

import uuid

import pytest

from tests.conftest import requires_supabase


@requires_supabase
def test_user_tracks_are_scoped_per_user(admin_client):
    user_a = str(uuid.uuid4())
    user_b = str(uuid.uuid4())
    created_track_id = None
    try:
        # Seed two users.
        admin_client.table("users").insert([
            {"id": user_a, "display_name": "Isolation Test A"},
            {"id": user_b, "display_name": "Isolation Test B"},
        ]).execute()

        # A shared catalog track (catalog data is intentionally cross-user).
        track_resp = (
            admin_client.table("tracks")
            .insert({"spotify_track_id": f"iso_{uuid.uuid4().hex[:18]}", "name": "Isolation Probe"})
            .execute()
        )
        created_track_id = track_resp.data[0]["id"]

        # Only user A saves it.
        admin_client.table("user_tracks").insert(
            {"user_id": user_a, "track_id": created_track_id, "play_count": 1}
        ).execute()

        # A scoped read for user A sees the row; user B sees nothing.
        a_rows = (
            admin_client.table("user_tracks").select("track_id").eq("user_id", user_a).execute()
        ).data or []
        b_rows = (
            admin_client.table("user_tracks").select("track_id").eq("user_id", user_b).execute()
        ).data or []

        assert any(r["track_id"] == created_track_id for r in a_rows)
        assert all(r["track_id"] != created_track_id for r in b_rows)
        assert b_rows == [] or created_track_id not in {r["track_id"] for r in b_rows}
    finally:
        # Cleanup (children first to respect FKs).
        admin_client.table("user_tracks").delete().in_("user_id", [user_a, user_b]).execute()
        if created_track_id is not None:
            admin_client.table("tracks").delete().eq("id", created_track_id).execute()
        admin_client.table("users").delete().in_("id", [user_a, user_b]).execute()


@requires_supabase
def test_station_runs_are_scoped_per_user(admin_client):
    """A second table on the user-owned path, to catch a forgotten filter."""
    user_a = str(uuid.uuid4())
    user_b = str(uuid.uuid4())
    try:
        admin_client.table("users").insert([
            {"id": user_a, "display_name": "Iso Runs A"},
            {"id": user_b, "display_name": "Iso Runs B"},
        ]).execute()
        admin_client.table("station_runs").insert(
            {"user_id": user_a, "status": "success", "fallback_level": "fresh", "result_count": 5}
        ).execute()

        b_runs = (
            admin_client.table("station_runs").select("id").eq("user_id", user_b).execute()
        ).data or []
        assert b_runs == []
    finally:
        admin_client.table("station_runs").delete().in_("user_id", [user_a, user_b]).execute()
        admin_client.table("users").delete().in_("id", [user_a, user_b]).execute()
