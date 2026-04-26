"""
Editorial source ingestion service.

For each active row in public.sources:
  1. Fetch the feed (RSS for blogs, Reddit `.rss` for subreddits).
  2. Parse entries with feedparser.
  3. Build a clean text excerpt (title + first paragraph of summary, HTML stripped).
  4. Match artist names from public.artists against the excerpt with word boundaries.
  5. For every (entry, matched artist) pair, queue a mention candidate.
  6. Embed all excerpts in a single Voyage call.
  7. Upsert into public.mentions with ON CONFLICT (source_id, url, artist_id) DO NOTHING.

This keeps re-runs idempotent — running every hour is safe and only writes
genuinely new mentions.

Uses admin_supabase (service role) throughout — ingestion is a trusted backend job.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

import feedparser
import httpx

from app.services.embedding import embedder
from app.services.supabase_client import admin_supabase


# Cap per-run cost: ~25 entries * 8 sources = 200 candidate posts max.
MAX_ENTRIES_PER_FEED = 25
# Voyage free tier batch limit; matches artist_embeddings.
MAX_EMBED_BATCH = 18
# Skip very short artist names ("M83", "U2", etc. would over-match common words).
MIN_ARTIST_NAME_LEN = 3
# Trim excerpts before embedding to keep token budget predictable.
EXCERPT_MAX_CHARS = 800


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def run_source_ingest() -> None:
    sources = _load_active_sources()
    if not sources:
        print("source_ingest: no active sources")
        return

    artist_index = _load_artist_index()
    if not artist_index:
        print("source_ingest: no artists in catalog yet — skipping mention extraction")
        return

    pattern = _build_artist_pattern(artist_index)
    print(f"source_ingest: scanning {len(sources)} sources against {len(artist_index)} artists")

    candidates: list[dict] = []
    with httpx.Client(timeout=20, follow_redirects=True) as client:
        for source in sources:
            try:
                entries = _fetch_feed(client, source["url"])
            except Exception as exc:
                print(f"source_ingest: fetch failed for {source['name']!r}: {exc}")
                continue

            matched = _extract_mentions(entries, source, pattern, artist_index)
            print(f"source_ingest: {source['name']} — {len(entries)} entries, {len(matched)} mentions")
            candidates.extend(matched)

    if not candidates:
        print("source_ingest: no mentions found")
        return

    _embed_and_upsert(candidates)
    print(f"source_ingest: done — wrote {len(candidates)} mention candidates")


# ---------------------------------------------------------------------------
# Catalog loaders
# ---------------------------------------------------------------------------


def _load_active_sources() -> list[dict]:
    result = (
        admin_supabase.table("sources")
        .select("id, name, kind, url, trust_weight")
        .eq("active", True)
        .execute()
    )
    return result.data or []


def _load_artist_index() -> dict[str, int]:
    """Lowercase artist name -> artist id. Skips short names that would over-match."""
    result = admin_supabase.table("artists").select("id, name").execute()
    rows = result.data or []
    index: dict[str, int] = {}
    for row in rows:
        name = (row.get("name") or "").strip()
        if len(name) < MIN_ARTIST_NAME_LEN:
            continue
        # First-write wins; identical names from different Spotify IDs collide
        # rarely enough that we accept the simpler dedupe semantics.
        index.setdefault(name.lower(), row["id"])
    return index


# ---------------------------------------------------------------------------
# Feed parsing
# ---------------------------------------------------------------------------


def _fetch_feed(client: httpx.Client, url: str) -> list[dict]:
    # feedparser can fetch directly, but routing through httpx gives us a real
    # User-Agent (Reddit blocks the default) and consistent timeouts.
    resp = client.get(url, headers={"User-Agent": "music-dashboard/0.1 (+ingest)"})
    resp.raise_for_status()
    parsed = feedparser.parse(resp.content)
    return list(parsed.entries[:MAX_ENTRIES_PER_FEED])


def _extract_mentions(
    entries: list[dict],
    source: dict,
    pattern: re.Pattern[str] | None,
    artist_index: dict[str, int],
) -> list[dict]:
    if pattern is None:
        return []

    out: list[dict] = []
    seen: set[tuple[int, str, int]] = set()

    for entry in entries:
        excerpt = _build_excerpt(entry)
        if not excerpt:
            continue

        title = (entry.get("title") or "").strip() or None
        url = (entry.get("link") or "").strip()
        if not url:
            continue

        published_at = _parse_published(entry)

        for match in pattern.finditer(excerpt):
            matched_text = match.group(0).lower()
            artist_id = artist_index.get(matched_text)
            if artist_id is None:
                continue

            key = (source["id"], url, artist_id)
            if key in seen:
                continue
            seen.add(key)

            out.append(
                {
                    "source_id": source["id"],
                    "artist_id": artist_id,
                    "artist_name_raw": match.group(0),
                    "title": title,
                    "url": url,
                    "excerpt": excerpt,
                    "published_at": published_at,
                }
            )

    return out


def _build_excerpt(entry: dict) -> str:
    title = (entry.get("title") or "").strip()
    summary = entry.get("summary") or entry.get("description") or ""
    summary_clean = _strip_html(summary)
    parts = [p for p in (title, summary_clean) if p]
    text = " — ".join(parts)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:EXCERPT_MAX_CHARS]


def _parse_published(entry: dict) -> str | None:
    raw = entry.get("published") or entry.get("updated")
    if not raw:
        return None
    try:
        dt = parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        return None
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Artist matching
# ---------------------------------------------------------------------------


def _build_artist_pattern(artist_index: dict[str, int]) -> re.Pattern[str] | None:
    if not artist_index:
        return None
    # Longest names first so multi-word artists ("Kid Cudi") win over substrings.
    names = sorted(artist_index.keys(), key=len, reverse=True)
    escaped = [re.escape(name) for name in names]
    pattern = r"(?<!\w)(?:" + "|".join(escaped) + r")(?!\w)"
    return re.compile(pattern, re.IGNORECASE)


def _strip_html(text: str) -> str:
    return re.sub(r"<[^>]+>", " ", text or "")


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------


def _embed_and_upsert(candidates: list[dict]) -> None:
    excerpts = [c["excerpt"] for c in candidates]

    vectors: list[list[float]] = []
    for start in range(0, len(excerpts), MAX_EMBED_BATCH):
        batch = excerpts[start : start + MAX_EMBED_BATCH]
        vectors.extend(embedder.embed(batch, input_type="document"))

    if len(vectors) != len(candidates):
        print(
            f"source_ingest: vector count mismatch "
            f"(got {len(vectors)}, expected {len(candidates)}) — aborting"
        )
        return

    rows = []
    for c, vec in zip(candidates, vectors):
        rows.append(
            {
                "source_id": c["source_id"],
                "artist_id": c["artist_id"],
                "artist_name_raw": c["artist_name_raw"],
                "title": c["title"],
                "url": c["url"],
                "excerpt": c["excerpt"],
                "published_at": c["published_at"],
                "embedding": vec,
            }
        )

    admin_supabase.table("mentions").upsert(
        rows,
        on_conflict="source_id,url,artist_id",
        ignore_duplicates=True,
    ).execute()
