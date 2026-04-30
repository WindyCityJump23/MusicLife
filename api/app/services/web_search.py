"""Live web search to augment the editorial signal at Discover time.

Architecture: at every Discover click we already embed the user's prompt
and compare it (cosine) against pre-stored mention embeddings in the DB.
Those mentions come from the cron-style /ingest/sources job and can be
hours-to-days stale. Tavily lets us add a small handful of *fresh* hits
to that pool without changing any of the downstream scoring math.

Fail-soft contract: every entry point in this module returns an empty
list (or no-op) on failure. Discover must never break because Tavily
is slow, mis-configured, or rate-limited. If TAVILY_API_KEY is unset
the integration is silently disabled.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

import httpx

from app.config import settings


TAVILY_URL = "https://api.tavily.com/search"

# Trust weight applied to web-search results when they enter the editorial
# signal. Calibrated to sit between Stereogum (0.82) and Reddit (0.55–0.65)
# — fresh but not editorially curated.
WEB_TRUST_WEIGHT = 0.75
# Sentinel source_id used in `mentions_by_artist` for synthetic web mentions.
# Negative so it can't collide with real `sources.id` rows.
WEB_SOURCE_ID = -1
WEB_SOURCE_NAME = "Web (live)"

# Skip very short artist names ("U2", "M83") — they over-match common words.
MIN_ARTIST_NAME_LEN = 3
# Cap snippets before embedding to keep token budget predictable.
SNIPPET_MAX_CHARS = 800


def is_enabled() -> bool:
    return bool((settings.tavily_api_key or "").strip())


def search(query: str, limit: int = 5, timeout: float = 4.0) -> list[dict]:
    """Return up to `limit` Tavily results for `query`.

    Each result is `{title, content, url, score}` with `content` capped at
    SNIPPET_MAX_CHARS. Returns `[]` on disabled, empty query, timeout,
    HTTP error, or any parse failure — never raises.
    """
    if not is_enabled():
        return []
    q = (query or "").strip()
    if not q:
        return []

    payload = {
        "api_key": settings.tavily_api_key,
        # Bias toward music coverage so generic terms like "energetic" don't
        # pull workout/blog posts.
        "query": f"{q} music",
        "search_depth": "basic",
        "max_results": max(1, min(limit, 10)),
        "include_answer": False,
        "include_raw_content": False,
        "topic": "general",
    }

    try:
        with httpx.Client(timeout=timeout) as client:
            resp = client.post(TAVILY_URL, json=payload)
    except httpx.HTTPError as exc:
        print(f"web_search: Tavily request failed: {exc}")
        return []

    if resp.status_code != 200:
        print(f"web_search: Tavily HTTP {resp.status_code}: {resp.text[:120]}")
        return []

    try:
        data = resp.json()
    except ValueError:
        print("web_search: Tavily returned non-JSON")
        return []

    raw = data.get("results") or []
    out: list[dict] = []
    for r in raw[:limit]:
        content = (r.get("content") or "").strip()
        if not content:
            continue
        out.append(
            {
                "title": (r.get("title") or "").strip(),
                "content": content[:SNIPPET_MAX_CHARS],
                "url": (r.get("url") or "").strip(),
                "score": float(r.get("score") or 0.5),
            }
        )
    return out


def build_artist_pattern(artist_index: dict[str, int]) -> re.Pattern[str] | None:
    """Word-boundary regex over lowercase artist names, longest-first.

    Mirrors source_ingest._build_artist_pattern so behavior is consistent
    with the cron-side mention extraction.
    """
    names = [n for n in artist_index.keys() if len(n) >= MIN_ARTIST_NAME_LEN]
    if not names:
        return None
    names.sort(key=len, reverse=True)
    escaped = [re.escape(n) for n in names]
    pattern = r"(?<!\w)(?:" + "|".join(escaped) + r")(?!\w)"
    return re.compile(pattern, re.IGNORECASE)


def extract_artist_mentions(
    results: list[dict],
    artist_index: dict[str, int],
    pattern: re.Pattern[str] | None = None,
) -> dict[int, list[dict]]:
    """For each web result, find which catalog artists it mentions.

    Returns `{artist_id: [synthetic_mention, ...]}` where each synthetic
    mention has the same shape as a row from `public.mentions` plus an
    `_excerpt_text` field carrying the snippet so callers can embed it
    in a single Voyage batch.
    """
    if not results or not artist_index:
        return {}

    if pattern is None:
        pattern = build_artist_pattern(artist_index)
    if pattern is None:
        return {}

    now_iso = datetime.now(timezone.utc).isoformat()
    out: dict[int, list[dict]] = {}

    for r in results:
        haystack = f"{r.get('title') or ''} {r.get('content') or ''}".lower()
        seen_in_this_result: set[int] = set()
        for match in pattern.finditer(haystack):
            name_lower = match.group(0).lower()
            artist_id = artist_index.get(name_lower)
            if artist_id is None or artist_id in seen_in_this_result:
                continue
            seen_in_this_result.add(int(artist_id))

            out.setdefault(int(artist_id), []).append(
                {
                    "source_id": WEB_SOURCE_ID,
                    "artist_id": int(artist_id),
                    "published_at": now_iso,  # treat web hits as "now"
                    "sentiment": 0.6,         # neutral-positive default
                    "excerpt": (r.get("content") or "")[:400],
                    "_excerpt_text": r.get("content") or "",
                    "_url": r.get("url") or "",
                    "_title": r.get("title") or "",
                }
            )
    return out
