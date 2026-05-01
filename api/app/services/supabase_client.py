from __future__ import annotations

from supabase import Client, ClientOptions, create_client

from app.config import settings


class _LazyAdminClient:
    """Defers create_client() until the first attribute access.

    Module-level construction calls create_client() immediately, which
    validates the API key format and raises if the key is a placeholder.
    Evals import this module (transitively via synthesize.py) but never
    actually use the admin client — they supply their own MockSupabaseClient.
    Lazy initialization keeps the import side-effect-free for those callers.
    """

    _client: Client | None = None

    def _get(self) -> Client:
        if self._client is None:
            self._client = create_client(
                settings.supabase_url,
                settings.supabase_service_role_key,
            )
        return self._client

    def __getattr__(self, name: str):
        return getattr(self._get(), name)


# Service role client: use only for trusted backend jobs/admin operations.
admin_supabase: Client = _LazyAdminClient()  # type: ignore[assignment]


def get_user_scoped_supabase(jwt: str) -> Client:
    """Create a per-request Supabase client constrained by the caller JWT.

    When the token is the service role key itself (server-to-server BFF calls)
    we return the admin client directly — it already has full access and the
    anon-key path would silently fail RLS for catalog-only tables.

    For real user JWTs, we use the anon key + Authorization header so Postgres
    RLS policies evaluate against `auth.uid()` of the caller.
    """
    if jwt == settings.supabase_service_role_key:
        return admin_supabase

    options = ClientOptions(
        headers={"Authorization": f"Bearer {jwt}"},
        auto_refresh_token=False,
        persist_session=False,
    )
    return create_client(settings.supabase_url, settings.supabase_anon_key, options)
