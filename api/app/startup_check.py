"""
Startup environment validation.

Called once from main.py on app startup. Prints clear, actionable error
messages for every missing or obviously-wrong config value, then raises
RuntimeError to abort launch rather than silently serving broken endpoints.
"""
from __future__ import annotations

import sys


def run_checks() -> None:
    errors: list[str] = []

    try:
        from app.config import settings
    except Exception as exc:
        print(f"\n[startup] FATAL: could not load settings — {exc}", file=sys.stderr)
        raise

    # ── Required for any endpoint to work ──────────────────────────────────
    if not settings.supabase_url:
        errors.append("SUPABASE_URL is not set")
    if not settings.supabase_service_role_key:
        errors.append("SUPABASE_SERVICE_ROLE_KEY is not set")
    if not settings.supabase_anon_key:
        errors.append("SUPABASE_ANON_KEY is not set")

    # ── Required for /synthesize (optional — API boots without it) ───────────
    if not settings.anthropic_api_key or settings.anthropic_api_key.startswith("placeholder"):
        print("[startup] WARNING: ANTHROPIC_API_KEY not set — /synthesize will return errors")

    # ── Required for embedding jobs ─────────────────────────────────────────
    provider = settings.embedding_provider.lower().strip()
    if provider == "voyage" and not settings.voyage_api_key:
        errors.append(
            "EMBEDDING_PROVIDER=voyage but VOYAGE_API_KEY is not set"
        )
    elif provider == "openai" and not settings.openai_api_key:
        errors.append(
            "EMBEDDING_PROVIDER=openai but OPENAI_API_KEY is not set"
        )
    elif provider not in ("voyage", "openai"):
        errors.append(
            f"EMBEDDING_PROVIDER={provider!r} is not supported (use 'voyage' or 'openai')"
        )

    # ── Required for artist enrichment ──────────────────────────────────────
    if not settings.lastfm_api_key:
        errors.append("LASTFM_API_KEY is not set (needed for /ingest/enrich-artists)")
    if not settings.musicbrainz_user_agent:
        errors.append(
            "MUSICBRAINZ_USER_AGENT is not set "
            "(format: appname/version (email@example.com))"
        )

    if errors:
        print("\n[startup] Missing or invalid environment variables:\n", file=sys.stderr)
        for e in errors:
            print(f"  ✗ {e}", file=sys.stderr)
        print(
            "\nCopy api/.env.example → api/.env and fill in all values.\n"
            "See docs/SETUP.md for where to get each key.\n",
            file=sys.stderr,
        )
        raise RuntimeError(
            f"Startup aborted: {len(errors)} missing config value(s). See stderr above."
        )

    print(
        f"[startup] Config OK — provider={provider}, "
        f"model={settings.embedding_model}, dims={settings.embedding_dims}"
    )
