"""
Diagnostics endpoint for the ranking pipeline.

POST /diagnostics/ranking — run static + runtime checks against the
recommendation pipeline and return a structured report of findings.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, Field

from app.deps.auth import bearer_scheme, ensure_valid_bearer_token, require_bearer_token
from app.services.supabase_client import get_user_scoped_supabase

router = APIRouter()


class DiagnosticsRequest(BaseModel):
    user_id: str
    prompts: list[str | None] | None = None
    run_static: bool = True
    run_runtime: bool = True
    limit: int = Field(default=30, ge=1, le=100)


@router.post("/ranking")
def ranking_diagnostics(
    req: DiagnosticsRequest,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
):
    token = require_bearer_token(credentials)
    ensure_valid_bearer_token(token)
    user_client = get_user_scoped_supabase(token) if req.run_runtime else None

    from app.services.ranking_diagnostics import run_diagnostics

    report = run_diagnostics(
        client=user_client,
        user_id=req.user_id,
        prompts=req.prompts,
        run_static=req.run_static,
        run_runtime=req.run_runtime,
        auto_fix_enabled=False,
        limit=req.limit,
    )

    return report.as_dict()


@router.post("/ranking/static")
def ranking_static_diagnostics(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
):
    """Run only the static (no-DB) checks.

    Requires a valid bearer token. These checks reveal ranking internals, so
    the endpoint is no longer anonymous. CI runs the same checks by importing
    ``run_diagnostics`` directly (see .github/workflows/deploy.yml), so gating
    the HTTP surface does not affect the pipeline.
    """
    token = require_bearer_token(credentials)
    ensure_valid_bearer_token(token)

    from app.services.ranking_diagnostics import run_diagnostics

    report = run_diagnostics(
        run_static=True,
        run_runtime=False,
    )
    return report.as_dict()
