"""
Editorial source ingestion service.

For each active row in public.sources:
  1. Fetch the feed (RSS for blogs, Reddit `.rss` for subreddits).
  2. Parse entries with feedparser.
  3. Build a clean text excerpt (title + first paragraph of summary, HTML stripped).
  4. Match artist names from public.artists against the excerpt with word boundaries.
  5. For every (entry, matched artist) pair, queue a mention candidate.
  6. Drop candidates that are already in the DB (so re-runs don't re-embed).
  7. Embed remaining excerpts in batches; survive partial Voyage failures.
  8. Upsert into public.mentions with ON CONFLICT (source_id, url, artist_id) DO NOTHING.

This keeps re-runs idempotent — running every hour is safe and only writes
genuinely new mentions.

Uses admin_supabase (service role) throughout — ingestion is a trusted backend job.
"""

from __future__ import annotations

import re
from collections import defaultdict
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


def run_source_ingest() -> dict:
    """Crawl all active sources and ingest new mentions.

    Returns a summary dict so callers can surface real counts in the
    job UI (rather than a generic "Sources ingested" message):

        {
          "sources_total":     int,  # rows in `sources` table
          "sources_succeeded": int,  # feeds fetched without error
          "sources_failed":    int,
          "mentions_found":    int,  # raw matches before dedup
          "mentions_new":      int,  # candidates after DB dedup
          "mentions_written":  int,  # rows actually upserted
          "summary":           str,  # human-readable one-liner
        }
    """
    sources = _load_active_sources()
    if not sources:
        msg = "no active sources configured"
        print(f"source_ingest: {msg}")
        return _empty_summary(0, msg)

    artist_index = _load_artist_index()
    if not artist_index:
        msg = "no artists in catalog yet — sync your library first"
        print(f"source_ingest: {msg}")
        return _empty_summary(len(sources), msg)

    pattern = _build_artist_pattern(artist_index)
    print(f"source_ingest: scanning {len(sources)} sources against {len(artist_index)} artists")

    candidates: list[dict] = []
    sources_succeeded = 0
    sources_failed = 0
    per_source_counts: dict[str, int] = defaultdict(int)

    with httpx.Client(timeout=20, follow_redirects=True) as client:
        for source in sources:
            try:
                entries = _fetch_feed(client, source["url"])
            except Exception as exc:
                sources_failed += 1
                print(f"source_ingest: fetch failed for {source['name']!r}: {exc}")
                continue

            sources_succeeded += 1
            matched = _extract_mentions(entries, source, pattern, artist_index)
            per_source_counts[source["name"]] = len(matched)
            print(f"source_ingest: {source['name']} — {len(entries)} entries, {len(matched)} mentions")
            candidates.extend(matched)

    mentions_found = len(candidates)

    # Drop candidates whose (source_id, url, artist_id) already exists in
    # `mentions`. Avoids burning Voyage tokens re-embedding stale rows.
    new_candidates = _filter_already_stored(candidates)
    mentions_new = len(new_candidates)
    skipped_existing = mentions_found - mentions_new
    if skipped_existing:
        print(f"source_ingest: skipped {skipped_existing} mentions already stored")

    mentions_written = 0
    if new_candidates:
        mentions_written = _embed_and_upsert(new_candidates)

    summary = _format_summary(
        sources_succeeded,
        sources_failed,
        len(sources),
        mentions_written,
        skipped_existing,
    )
    print(f"source_ingest: done — {summary}")

    return {
        "sources_total": len(sources),
        "sources_succeeded": sources_succeeded,
        "sources_failed": sources_failed,
        "mentions_found": mentions_found,
        "mentions_new": mentions_new,
        "mentions_written": mentions_written,
        "summary": summary,
    }


def _empty_summary(sources_total: int, reason: str) -> dict:
    return {
        "sources_total": sources_total,
        "sources_succeeded": 0,
        "sources_failed": 0,
        "mentions_found": 0,
        "mentions_new": 0,
        "mentions_written": 0,
        "summary": reason,
    }


def _format_summary(
    succeeded: int, failed: int, total: int, written: int, skipped: int
) -> str:
    parts = [f"{written} new mention{'' if written == 1 else 's'}"]
    parts.append(f"from {succeeded}/{total} feed{'' if total == 1 else 's'}")
    if failed:
        parts.append(f"({failed} failed)")
    if skipped:
        parts.append(f"— {skipped} already stored")
    return " ".join(parts)


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


def _filter_already_stored(candidates: list[dict]) -> list[dict]:
    """Remove candidates whose (source_id, url, artist_id) already exists.

    The dedup constraint would silently drop them on upsert anyway, but
    embedding is the expensive step — skip it for rows we're going to
    discard. Queries by (source_id, url) groups so we can use an `in_`
    filter instead of N round trips.
    """
    if not candidates:
        return []

    by_source: dict[int, set[str]] = defaultdict(set)
    for c in candidates:
        by_source[int(c["source_id"])].add(c["url"])

    existing: set[tuple[int, str, int]] = set()
    for source_id, urls in by_source.items():
        url_list = list(urls)
        # Page through urls in chunks; PostgREST .in_ has practical limits.
        for start in range(0, len(url_list), 100):
            chunk = url_list[start : start + 100]
            try:
                resp = (
                    admin_supabase.table("mentions")
                    .select("source_id,url,artist_id")
                    .eq("source_id", source_id)
                    .in_("url", chunk)
                    .execute()
                )
            except Exception as exc:
                # If the lookup fails, fall through and let the upsert
                # path handle dedup. Worse case: we re-embed.
                print(f"source_ingest: dedup lookup failed for source {source_id}: {exc}")
                continue
            for row in resp.data or []:
                if row.get("artist_id") is None:
                    continue
                existing.add(
                    (int(row["source_id"]), row["url"], int(row["artist_id"]))
                )

    if not existing:
        return list(candidates)

    return [
        c for c in candidates
        if (int(c["source_id"]), c["url"], int(c["artist_id"])) not in existing
    ]


def _embed_and_upsert(candidates: list[dict]) -> int:
    """Embed candidates in batches and upsert each batch independently.

    A single Voyage failure no longer aborts the whole run — successful
    batches are written and the failed one is skipped. Returns the
    number of rows actually upserted.
    """
    written = 0
    for start in range(0, len(candidates), MAX_EMBED_BATCH):
        batch = candidates[start : start + MAX_EMBED_BATCH]
        excerpts = [c["excerpt"] for c in batch]

        try:
            vectors = embedder.embed(excerpts, input_type="document")
        except Exception as exc:
            print(
                f"source_ingest: embed batch {start // MAX_EMBED_BATCH} failed "
                f"({len(batch)} rows skipped): {exc}"
            )
            continue

        if len(vectors) != len(batch):
            print(
                f"source_ingest: embed batch {start // MAX_EMBED_BATCH} returned "
                f"{len(vectors)} vectors for {len(batch)} rows — skipping batch"
            )
            continue

        rows = [
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
            for c, vec in zip(batch, vectors)
        ]

        # Try upsert with dedup constraint first; fall back to plain insert
        # if the constraint hasn't been applied yet (migration 005).
        try:
            admin_supabase.table("mentions").upsert(
                rows,
                on_conflict="source_id,url,artist_id",
                ignore_duplicates=True,
            ).execute()
            written += len(rows)
        except Exception as upsert_err:
            if "42P10" in str(upsert_err):
                print(
                    "source_ingest: mentions_dedup_key constraint missing, "
                    "falling back to row-by-row insert"
                )
                for row in rows:
                    try:
                        admin_supabase.table("mentions").insert(row).execute()
                        written += 1
                    except Exception:
                        pass  # duplicate or transient — keep going
            else:
                print(f"source_ingest: upsert failed for batch starting at {start}: {upsert_err}")

    return written
