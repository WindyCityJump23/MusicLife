from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.services.supabase_client import get_user_scoped_supabase

bearer_scheme = HTTPBearer(auto_error=False)


def require_bearer_token(
    credentials: HTTPAuthorizationCredentials | None,
) -> str:
    if not credentials or not credentials.credentials:
        raise HTTPException(status_code=401, detail="Missing bearer token")
    return credentials.credentials


def ensure_valid_bearer_token(token: str) -> None:
    """Validate bearer token against Supabase auth and raise HTTP 401 if invalid."""
    try:
        client = get_user_scoped_supabase(token)
        client.auth.get_user(token)
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Invalid or expired bearer token") from exc
