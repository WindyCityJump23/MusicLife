from fastapi import HTTPException
from supabase import Client, ClientOptions, create_client

from app.config import settings

# Service role client: use only for trusted backend jobs/admin operations.
admin_supabase: Client = create_client(
    settings.supabase_url,
    settings.supabase_service_role_key,
)


def get_user_scoped_supabase(jwt: str) -> Client:
    """Create a per-request Supabase client constrained by the caller JWT."""
    options = ClientOptions(
        headers={"Authorization": f"Bearer {jwt}"},
        auto_refresh_token=False,
        persist_session=False,
    )
    return create_client(settings.supabase_url, settings.supabase_anon_key, options)


def get_validated_user_scoped_supabase(jwt: str) -> Client:
    """Return a JWT-scoped client after validating the token with Supabase Auth."""
    client = get_user_scoped_supabase(jwt)
    try:
        user_resp = client.auth.get_user(jwt)
    except Exception as exc:  # auth provider/network/parsing failures
        raise HTTPException(status_code=401, detail="Invalid or expired bearer token") from exc

    if not user_resp or not getattr(user_resp, "user", None):
        raise HTTPException(status_code=401, detail="Invalid or expired bearer token")

    return client
