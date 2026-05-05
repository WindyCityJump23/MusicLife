from __future__ import annotations

import time
from typing import Any, Callable, TypeVar

from supabase import Client, ClientOptions, create_client

# NOTE: settings is imported lazily inside the functions below. Importing it
# at module load time evaluates app.config.Settings() immediately, which
# raises pydantic ValidationError when env vars are missing — that breaks
# the eval suite (which imports ranking.py without setting any env vars).


class _LazyAdminClient:
    """Defers create_client() until the first attribute access.

    Module-level construction calls create_client() immediately, which
    validates the API key format and raises if the key is a placeholder.
    Evals import this module (transitively via synthesize.py) but never
    actually use the admin client — they supply their own MockSupabaseClient.
    Lazy initialization keeps the import side-effect-free for those callers.

    The cached client also rotates on a TTL. The original implementation
    held a single httpx-backed Client for the lifetime of the process, so
    a stale keep-alive connection that Supabase had silently closed would
    cause `httpx.RemoteProtocolError: Server disconnected` on whatever
    query happened to fire next. Recreating the client periodically caps
    the staleness window without forcing a TLS handshake per request.
    """

    _CLIENT_TTL_SECONDS = 90.0

    _client: Client | None = None
    _created_at: float = 0.0

    def _get(self) -> Client:
        now = time.monotonic()
        if self._client is None or (now - self._created_at) > self._CLIENT_TTL_SECONDS:
            from app.config import settings  # lazy: see module note above
            self._client = create_client(
                settings.supabase_url,
                settings.supabase_service_role_key,
            )
            self._created_at = now
        return self._client

    def invalidate(self) -> None:
        """Drop the cached client so the next access reconnects.

        Called by retry_on_disconnect when an httpx RemoteProtocolError
        bubbles up from a query — that error means the underlying TCP
        connection went away, so the client's pool must be discarded.
        """
        self._client = None
        self._created_at = 0.0

    def __getattr__(self, name: str):
        return getattr(self._get(), name)


# Service role client: use only for trusted backend jobs/admin operations.
admin_supabase: Client = _LazyAdminClient()  # type: ignore[assignment]


T = TypeVar("T")


def retry_on_disconnect(fn: Callable[[], T], *, attempts: int = 2) -> T:
    """Run fn(), retrying once if the shared admin client's TCP connection
    has gone stale (httpx.RemoteProtocolError). Other exceptions propagate
    immediately so genuine errors aren't swallowed.

    Used on the hot recommendation path so a single dropped keep-alive
    doesn't surface as a 25-second Vercel 504 to the user.
    """
    import httpx

    last_exc: Exception | None = None
    for attempt in range(attempts):
        try:
            return fn()
        except httpx.RemoteProtocolError as exc:
            last_exc = exc
            if isinstance(admin_supabase, _LazyAdminClient):
                admin_supabase.invalidate()
            if attempt + 1 >= attempts:
                raise
        except Exception:
            raise
    # Unreachable, but keeps type checkers honest.
    raise last_exc if last_exc else RuntimeError("retry_on_disconnect: no attempts")


def get_user_scoped_supabase(jwt: str) -> Client:
    """Create a per-request Supabase client constrained by the caller JWT.

    When the token is the service role key itself (server-to-server BFF calls)
    we return the admin client directly — it already has full access and the
    anon-key path would silently fail RLS for catalog-only tables.

    For real user JWTs, we use the anon key + Authorization header so Postgres
    RLS policies evaluate against `auth.uid()` of the caller.
    """
    from app.config import settings  # lazy: see module note above

    if jwt == settings.supabase_service_role_key:
        return admin_supabase

    options = ClientOptions(
        headers={"Authorization": f"Bearer {jwt}"},
        auto_refresh_token=False,
        persist_session=False,
    )
    return create_client(settings.supabase_url, settings.supabase_anon_key, options)
