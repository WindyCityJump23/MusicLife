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

Level 2 — Blog-sourced track catalog population:
  For RSS sources (not Reddit), also parse entry titles for Artist – Track patterns.
  When found, search Spotify for the specific track and upsert it into public.tracks,
  linked to the artist if they already exist in the catalog. This surfaces blog-curated
  deep cuts and new artists directly in the discovery engine.

This keeps re-runs idempotent — running every hour is safe and only writes
genuinely new mentions.

Uses admin_supabase (service role) throughout — ingestion is a trusted backend job.
"""

from __future__ import annotations

import base64
import json
import re
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Callable

import feedparser
import httpx

from app.services.embedding import embedder
from app.services.supabase_client import admin_supabase


# ── Mention ingestion limits ─────────────────────────────────────────────────
MAX_ENTRIES_PER_FEED = 25
MAX_EMBED_BATCH = 18
MIN_ARTIST_NAME_LEN = 3
EXCERPT_MAX_CHARS = 800

# ── Blog-track extraction limits ─────────────────────────────────────────────
# Cap total Spotify searches per run to avoid burning rate limits during Step 4.
MAX_BLOG_TRACK_SEARCHES = 60
TRACK_SEARCH_DELAY_S = 0.4  # ~2.5 req/sec — conservative for Client Credentials

# Title patterns ordered from most specific to most permissive.
# Group 1 = artist candidate, Group 2 = track candidate.
_TRACK_TITLE_RES = [
    # "Listen/Stream/Watch/Premiere: Artist – 'Track'" (quoted)
    re.compile(
        r'^(?:(?:listen|stream|watch|premiere|new music|song|video)\s*:\s*)?'
        r'(.+?)\s*[-–—]\s*["‘’“”](.+?)["‘’“”]',
        re.IGNORECASE,
    ),
    # Hype Machine / plain blogs: "Artist – Track Name" (no quotes, whole line)
    re.compile(
        r'^(?:(?:listen|stream|watch|premiere)\s*:\s*)?(.+?)\s*[-–—]\s*(.+)$',
        re.IGNORECASE,
    ),
]

# Prefixes that indicate the title is NOT about a single track.
_SKIP_PREFIXES = (
    "review:", "album review:", "ep review:", "interview:", "live review:",
    "top ", "best ", "playlist", "mix:", "roundup", "new releases:",
    "singles:", "this week", "album of",
)


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def run_source_ingest(
    progress: Callable[[str], None] | None = None,
    spotify_client_id: str | None = None,
    spotify_client_secret: str | None = None,
) -> None:
    sources = _load_active_sources()
    if not sources:
        print("source_ingest: no active sources")
        return

    artist_index = _load_artist_index()
    if not artist_index:
        print("source_ingest: no artists in catalog yet — skipping mention extraction")
        return

    pattern = _build_artist_pattern(artist_index)
    total = len(sources)
    print(f"source_ingest: scanning {total} sources against {len(artist_index)} artists")
    if progress:
        progress(f"Fetching editorial sources (0/{total})")

    # ── Level 2 setup ────────────────────────────────────────────────────────
    spotify_token: str | None = None
    spotify_artist_index: dict[str, int] = {}
    if spotify_client_id and spotify_client_secret:
        spotify_token = _get_spotify_cc_token(spotify_client_id, spotify_client_secret)
        if spotify_token:
            spotify_artist_index = _load_spotify_artist_index()
            print(f"source_ingest: Spotify CC token acquired, {len(spotify_artist_index)} artists indexed for track extraction")
        else:
            print("source_ingest: Spotify CC token unavailable — skipping blog track extraction")

    # ── Main loop ────────────────────────────────────────────────────────────
    candidates: list[dict] = []
    blog_tracks_added = 0
    blog_searches_remaining = MAX_BLOG_TRACK_SEARCHES

    with httpx.Client(timeout=20, follow_redirects=True) as client:
        spotify_headers = {"Authorization": f"Bearer {spotify_token}"} if spotify_token else {}

        reddit_failures = 0  # consecutive Reddit 429s; if >= 3 the IP is banned for this run
        skip_reddit = False

        for i, source in enumerate(sources):
            is_reddit = source.get("kind") == "reddit"
            if is_reddit and skip_reddit:
                print(f"source_ingest: {source['name']!r} — skipped (Reddit IP ban active this run)")
                if progress:
                    progress(f"Fetching editorial sources ({i + 1}/{total})")
                continue

            try:
                entries = _fetch_feed(client, source["url"])
                if is_reddit:
                    reddit_failures = 0  # successful Reddit request resets the counter
            except Exception as exc:
                print(f"source_ingest: fetch failed for {source['name']!r}: {exc}")
                if is_reddit and "429" in str(exc):
                    reddit_failures += 1
                    if reddit_failures >= 2:
                        skip_reddit = True
                        print("source_ingest: Reddit IP rate-limited — skipping remaining Reddit sources this run")
                if progress:
                    progress(f"Fetching editorial sources ({i + 1}/{total})")
                continue

            # Level 1 — editorial mention extraction
            matched = _extract_mentions(entries, source, pattern, artist_index)
            print(f"source_ingest: {source['name']} — {len(entries)} entries, {len(matched)} mentions")
            candidates.extend(matched)

            # Level 2 — blog track catalog population (RSS sources only)
            if spotify_token and source.get("kind") == "rss" and blog_searches_remaining > 0:
                added, searched = _extract_and_upsert_blog_tracks(
                    client, spotify_headers, entries, source["name"],
                    spotify_artist_index, blog_searches_remaining,
                )
                blog_tracks_added += added
                blog_searches_remaining -= searched
                if added > 0:
                    print(f"source_ingest: {source['name']} — added {added} blog-sourced tracks")

            if progress:
                progress(f"Fetching editorial sources ({i + 1}/{total})")

    if not candidates:
        print("source_ingest: no mentions found")
    else:
        if progress:
            progress(f"Fetching editorial sources (embedding {len(candidates)} mentions)")
        _embed_and_upsert(candidates)
        print(f"source_ingest: done — wrote {len(candidates)} mention candidates")

    if spotify_token:
        print(f"source_ingest: blog track extraction — {blog_tracks_added} tracks upserted "
              f"({MAX_BLOG_TRACK_SEARCHES - blog_searches_remaining} Spotify searches)")


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
    """Lowercase artist name → artist db id."""
    result = admin_supabase.table("artists").select("id, name").execute()
    rows = result.data or []
    index: dict[str, int] = {}
    for row in rows:
        name = (row.get("name") or "").strip()
        if len(name) < MIN_ARTIST_NAME_LEN:
            continue
        index.setdefault(name.lower(), row["id"])
    return index


def _load_spotify_artist_index() -> dict[str, int]:
    """Spotify artist id → db artist id, for blog track matching."""
    result = (
        admin_supabase.table("artists")
        .select("id, spotify_artist_id")
        .not_.is_("spotify_artist_id", "null")
        .execute()
    )
    return {
        row["spotify_artist_id"]: row["id"]
        for row in (result.data or [])
        if row.get("spotify_artist_id")
    }


# ---------------------------------------------------------------------------
# Feed parsing
# ---------------------------------------------------------------------------


_REDDIT_UA = "MusicLife:music-discovery-app:0.1 (by /u/musiclife_bot; aggregator)"
_DEFAULT_UA = "MusicLife-ingest/0.1"

def _fetch_feed(client: httpx.Client, url: str) -> list[dict]:
    is_reddit = "reddit.com" in url
    ua = _REDDIT_UA if is_reddit else _DEFAULT_UA
    # Reddit: add a polite delay before each request to reduce IP-level rate limits,
    # then allow 2 retries with backoff. Non-Reddit: 2 quick retries.
    if is_reddit:
        time.sleep(2)  # base inter-source delay for Reddit
    delays = [5, 15] if is_reddit else [2, 5]
    for attempt, delay in enumerate([0] + delays):
        if delay:
            time.sleep(delay)
        try:
            resp = client.get(url, headers={"User-Agent": ua})
            if resp.status_code == 429:
                if attempt < len(delays):
                    continue
                resp.raise_for_status()
            resp.raise_for_status()
            break
        except httpx.HTTPStatusError:
            if attempt < len(delays):
                continue
            raise
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
    names = sorted(artist_index.keys(), key=len, reverse=True)
    escaped = [re.escape(name) for name in names]
    pattern = r"(?<!\w)(?:" + "|".join(escaped) + r")(?!\w)"
    return re.compile(pattern, re.IGNORECASE)


def _strip_html(text: str) -> str:
    return re.sub(r"<[^>]+>", " ", text or "")


# ---------------------------------------------------------------------------
# Level 2 — Blog track extraction
# ---------------------------------------------------------------------------


def _extract_track_pair(title: str) -> tuple[str, str] | None:
    """Parse a blog/Hype Machine title into (artist, track_name), or None."""
    title = title.strip()
    tl = title.lower()

    # Skip titles that clearly aren't about a single track
    if any(tl.startswith(p) for p in _SKIP_PREFIXES):
        return None
    # Skip if it looks like a list ("10 Songs…", "5 Albums…")
    if re.match(r'^\d+\s+', title):
        return None

    for pat in _TRACK_TITLE_RES:
        m = pat.match(title)
        if not m:
            continue
        artist = m.group(1).strip().strip("\"'‘’“”")
        track = m.group(2).strip().strip("\"'‘’“”")
        # Strip trailing junk like "[Official Video]", "(feat. X)", "(prod. Y)"
        track = re.sub(r'\s*[\(\[](?:official|video|audio|feat\.|ft\.|prod\.)[^\)\]]*[\)\]]', '', track, flags=re.IGNORECASE).strip()
        if 2 <= len(artist) <= 80 and 2 <= len(track) <= 120:
            return (artist, track)

    return None


def _extract_and_upsert_blog_tracks(
    client: httpx.Client,
    spotify_headers: dict[str, str],
    entries: list[dict],
    source_name: str,
    spotify_artist_index: dict[str, int],
    search_budget: int,
) -> tuple[int, int]:
    """Parse track pairs from feed entries and upsert matched tracks.

    Returns (tracks_added, searches_used).
    """
    added = 0
    searched = 0

    for entry in entries:
        if searched >= search_budget:
            break

        title = (entry.get("title") or "").strip()
        if not title:
            continue

        pair = _extract_track_pair(title)
        if not pair:
            continue

        artist_name, track_name = pair
        track_obj = _search_spotify_track(client, spotify_headers, artist_name, track_name)
        searched += 1

        if track_obj is None:
            continue
        if track_obj == "RATE_LIMITED":
            print(f"source_ingest: Spotify rate-limited during blog track extraction — stopping")
            break

        # Match the Spotify artist to our catalog by Spotify artist ID
        spotify_artists = track_obj.get("artists") or []
        artist_db_id: int | None = None
        for sa in spotify_artists:
            sid = sa.get("id")
            if sid and sid in spotify_artist_index:
                artist_db_id = spotify_artist_index[sid]
                break

        # Only upsert tracks where we can link to a catalog artist
        if artist_db_id is None:
            continue

        if _upsert_blog_track(track_obj, artist_db_id):
            added += 1

        time.sleep(TRACK_SEARCH_DELAY_S)

    return added, searched


def _search_spotify_track(
    client: httpx.Client,
    headers: dict[str, str],
    artist: str,
    track: str,
) -> dict | None | str:
    """Search Spotify for artist+track. Returns track object, None, or 'RATE_LIMITED'."""
    quoted_artist = artist.replace('"', '\\"')
    quoted_track = track.replace('"', '\\"')
    query = f'artist:"{quoted_artist}" track:"{quoted_track}"'
    try:
        resp = client.get(
            "https://api.spotify.com/v1/search",
            params={"q": query, "type": "track", "market": "US", "limit": 1},
            headers=headers,
        )
        if resp.status_code == 200:
            items = (resp.json().get("tracks") or {}).get("items") or []
            return items[0] if items else None
        if resp.status_code == 429:
            return "RATE_LIMITED"
        if resp.status_code == 401:
            return "RATE_LIMITED"  # Token expired — stop gracefully
    except Exception:
        pass
    return None


def _upsert_blog_track(track_obj: dict, artist_db_id: int) -> bool:
    """Upsert a Spotify track object into the tracks table."""
    spotify_track_id = track_obj.get("id")
    if not spotify_track_id:
        return False

    album = track_obj.get("album") or {}
    album_name = album.get("name")
    track_name = track_obj.get("name") or "Unknown"

    release_date: str | None = None
    raw_date = album.get("release_date") or ""
    if raw_date:
        parts = raw_date.split("-")
        if len(parts) == 1:
            release_date = f"{parts[0]}-01-01"
        elif len(parts) == 2:
            release_date = f"{parts[0]}-{parts[1]}-01"
        else:
            release_date = raw_date

    # embedding_source drives the track embedding job (step after track population)
    spotify_artists = track_obj.get("artists") or []
    artist_name = spotify_artists[0].get("name") if spotify_artists else None
    embedding_source_parts = [p for p in [artist_name, track_name, album_name] if p]
    embedding_source = " – ".join(embedding_source_parts) if embedding_source_parts else None

    row = {
        "spotify_track_id": spotify_track_id,
        "artist_id": artist_db_id,
        "name": track_name,
        "album_name": album_name,
        "release_date": release_date,
        "duration_ms": track_obj.get("duration_ms"),
        "explicit": track_obj.get("explicit") or False,
        "popularity": track_obj.get("popularity"),
        "embedding_source": embedding_source,
    }

    try:
        admin_supabase.table("tracks").upsert(
            row, on_conflict="spotify_track_id"
        ).execute()
        return True
    except Exception as exc:
        print(f"source_ingest: failed to upsert blog track {spotify_track_id}: {exc}")
        return False


# ---------------------------------------------------------------------------
# Spotify Client Credentials token
# ---------------------------------------------------------------------------


def _get_spotify_cc_token(client_id: str, client_secret: str) -> str | None:
    """Get a Spotify Client Credentials access token (no user auth required)."""
    creds = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    data = urllib.parse.urlencode({"grant_type": "client_credentials"}).encode()
    req = urllib.request.Request(
        "https://accounts.spotify.com/api/token",
        data=data,
        headers={
            "Authorization": f"Basic {creds}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())["access_token"]
    except Exception as exc:
        print(f"source_ingest: Spotify CC token request failed — {exc}")
        return None


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

    try:
        admin_supabase.table("mentions").upsert(
            rows,
            on_conflict="source_id,url,artist_id",
            ignore_duplicates=True,
        ).execute()
    except Exception as upsert_err:
        if "42P10" in str(upsert_err):
            print("source_ingest: mentions_dedup_key constraint missing, falling back to row-by-row insert")
            inserted = 0
            for row in rows:
                try:
                    admin_supabase.table("mentions").insert(row).execute()
                    inserted += 1
                except Exception:
                    pass
            print(f"source_ingest: inserted {inserted}/{len(rows)} mentions (row-by-row fallback)")
        else:
            raise
