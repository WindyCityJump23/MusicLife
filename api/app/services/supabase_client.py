from supabase import Client, ClientOptions, create_client

from app.config import settings

# Service role client: use only for trusted backend jobs/admin operations.
admin_supabase: Client = create_client(
    settings.supabase_url,
    settings.supabase_service_role_key,
)


def get_user_scoped_supabase(jwt: str) -> Client:
    """Create a per-request Supabase client constrained by the caller JWT.

    This client uses the anon key + Authorization header so Postgres RLS
    policies evaluate against `auth.uid()` of the caller.
    """

    options = ClientOptions(
        headers={"Authorization": f"Bearer {jwt}"},
        auto_refresh_token=False,
        persist_session=False,
    )
    return create_client(settings.supabase_url, settings.supabase_anon_key, options)
