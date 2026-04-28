from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import settings
from app.services.supabase_client import get_user_scoped_supabase

bearer_scheme = HTTPBearer(auto_error=False)


def require_bearer_token(
    credentials: HTTPAuthorizationCredentials | None,
) -> str:
    if not credentials or not credentials.credentials:
        raise HTTPException(status_code=401, detail="Missing bearer token")
    return credentials.credentials


def ensure_valid_bearer_token(token: str) -> None:
    """Validate bearer token against Supabase auth and raise HTTP 401 if invalid.

    Accepts either:
    - A real Supabase user JWT (verified via auth.get_user).
    - The service role key itself (trusted server-to-server calls from the
      Next.js BFF layer, which never exposes the key to the browser).
    """
    # Service-role key is a trusted bypass — no network round-trip needed.
    if token == settings.supabase_service_role_key:
        return

    try:
        client = get_user_scoped_supabase(token)
        client.auth.get_user(token)
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Invalid or expired bearer token") from exc
