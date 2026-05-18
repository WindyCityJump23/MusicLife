"""Generate live Spotify Search intents outside the local catalog.

The local recommender is intentionally DB-first. This helper creates compact,
style-oriented search phrases from the user's taste so the web app can pull a
fresh candidate pool from Spotify without hard-coding familiar artists.
"""
from __future__ import annotations

import json
import re
from collections import Counter
from datetime import datetime, timezone
from typing import Any

from anthropic import Anthropic

from app.config import settings
from app.services.query_intent import interpret_music_prompt

_client: Anthropic | None = None
_NON_STYLE_GENRES = {"spotify", "seen live", "favorites", "favorite"}
_CURRENT_YEAR = datetime.now(timezone.utc).year


def build_live_candidate_intents(
    client,
    user_id: str,
    prompt: str | None = None,
    limit: int = 8,
    genre_boosts: list[str] | None = None,
    genre_avoids: list[str] | None = None,
    freshness: str = "balanced",
) -> dict[str, Any]:
    """Return style/search intents for live Spotify candidate expansion."""

    limit = max(1, min(limit, 12))
    brief = _build_taste_brief(
        client,
        user_id,
        prompt,
        genre_boosts=genre_boosts or [],
        genre_avoids=genre_avoids or [],
        freshness=freshness,
    )
    intents = _anthropic_intents(brief, limit) or _heuristic_intents(brief, limit)
    return {
        "intents": intents[:limit],
        "source": "anthropic" if brief.get("_anthropic_used") else "heuristic",
        "taste_brief": {
            "genres": brief["genres"][:12],
            "prompt": brief["prompt"],
            "recent_tracks": brief["recent_tracks"][:8],
            "top_artists": brief["top_artists"][:8],
            "genre_boosts": brief["genre_boosts"][:8],
            "genre_avoids": brief["genre_avoids"][:8],
            "freshness": brief["freshness"],
        },
    }


def _get_anthropic() -> Anthropic | None:
    global _client
    if not settings.anthropic_api_key or settings.anthropic_api_key.startswith("placeholder"):
        return None
    if _client is None:
        _client = Anthropic(api_key=settings.anthropic_api_key)
    return _client


def _build_taste_brief(
    client,
    user_id: str,
    prompt: str | None,
    genre_boosts: list[str],
    genre_avoids: list[str],
    freshness: str,
) -> dict[str, Any]:
    genre_counts: Counter[str] = Counter()
    recent_tracks: list[str] = []
    top_artists: list[str] = []
    clean_boosts = [_normalize_strategy_genre(genre) for genre in genre_boosts]
    clean_boosts = [genre for genre in clean_boosts if genre]
    clean_avoids = set(_normalize_strategy_genre(genre) for genre in genre_avoids)
    clean_avoids.discard("")

    try:
        top_resp = (
            client.table("user_top_artists")
            .select("term,rank,artists(name,genres)")
            .eq("user_id", user_id)
            .order("rank", desc=False)
            .range(0, 59)
            .execute()
        )
        for row in top_resp.data or []:
            artist = row.get("artists") or {}
            name = artist.get("name")
            if name and name not in top_artists:
                top_artists.append(name)
            rank = int(row.get("rank") or 50)
            term = row.get("term") or "long_term"
            term_boost = {"short_term": 3.0, "medium_term": 2.0, "long_term": 1.0}.get(term, 1.0)
            weight = term_boost * max(0.2, 1.0 - (rank - 1) / 50.0)
            for genre in artist.get("genres") or []:
                _add_genre(genre_counts, genre, weight)
    except Exception:
        pass

    try:
        track_resp = (
            client.table("user_tracks")
            .select("added_at,play_count,last_played_at,tracks(name,popularity,artists(name,genres))")
            .eq("user_id", user_id)
            .order("added_at", desc=True)
            .range(0, 119)
            .execute()
        )
        for row in track_resp.data or []:
            track = row.get("tracks") or {}
            artist = track.get("artists") or {}
            track_name = track.get("name")
            artist_name = artist.get("name")
            if track_name and artist_name and len(recent_tracks) < 24:
                recent_tracks.append(f"{track_name} - {artist_name}")
            play_weight = max(float(row.get("play_count") or 0.0), 1.0)
            if row.get("last_played_at"):
                play_weight += 2.0
            for genre in artist.get("genres") or []:
                _add_genre(genre_counts, genre, play_weight)
    except Exception:
        pass

    try:
        fav_resp = (
            client.table("user_favorites")
            .select("track_name,artist_name,created_at")
            .eq("user_id", user_id)
            .order("created_at", desc=True)
            .range(0, 49)
            .execute()
        )
        for row in fav_resp.data or []:
            track_name = row.get("track_name")
            artist_name = row.get("artist_name")
            if track_name and artist_name and len(recent_tracks) < 32:
                recent_tracks.append(f"{track_name} - {artist_name}")
    except Exception:
        pass

    intent = interpret_music_prompt(prompt)
    descriptors = intent.descriptors if intent else []
    for genre in clean_boosts:
        genre_counts[genre] += 25.0

    genres = [
        genre
        for genre, _ in genre_counts.most_common(30)
        if genre not in clean_avoids
    ]

    return {
        "prompt": intent.search_phrase if intent else (prompt or "").strip(),
        "expanded_prompt": intent.expanded_prompt if intent else "",
        "descriptors": descriptors,
        "genres": genres,
        "genre_boosts": clean_boosts,
        "genre_avoids": sorted(clean_avoids),
        "freshness": freshness if freshness in {"newer", "balanced", "timeless"} else "balanced",
        "recent_tracks": recent_tracks,
        "top_artists": top_artists[:20],
        "_anthropic_used": False,
    }


def _add_genre(counter: Counter[str], genre: str, weight: float) -> None:
    clean = _normalize_strategy_genre(genre)
    if not clean or clean in _NON_STYLE_GENRES:
        return
    counter[clean] += max(weight, 0.1)


def _normalize_strategy_genre(genre: Any) -> str:
    return re.sub(r"\s+", " ", str(genre or "").strip().lower())[:60]


def _anthropic_intents(brief: dict[str, Any], limit: int) -> list[dict[str, str]]:
    client = _get_anthropic()
    if client is None:
        return []

    system = (
        "You create Spotify Search queries for a music discovery app. "
        "Return only compact JSON. The queries must describe styles, eras, moods, "
        "instruments, scenes, or energy. Do not recommend or name specific artists. "
        "Do not produce 'for fans of' language. Avoid overfitting to legacy rock."
    )
    user = {
        "current_prompt": brief["prompt"],
        "expanded_prompt": brief["expanded_prompt"],
        "top_genres": brief["genres"][:12],
        "priority_genres": brief["genre_boosts"][:8],
        "soft_avoid_genres": brief["genre_avoids"][:8],
        "freshness_preference": brief["freshness"],
        "recent_saved_tracks": brief["recent_tracks"][:12],
        "top_artists_context_only_do_not_name_in_queries": brief["top_artists"][:10],
        "current_year": _CURRENT_YEAR,
        "instructions": (
            f"Return {limit} objects with keys query, label, reason. "
            "Queries should work in Spotify's general track search box and should be 3-8 words. "
            "Use priority genres when present. Avoid soft_avoid genres unless the prompt explicitly asks for them. "
            "If freshness_preference is newer, include current or recent discovery language."
        ),
    }

    try:
        resp = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=700,
            temperature=0.7,
            system=system,
            messages=[{"role": "user", "content": json.dumps(user)}],
        )
        text = "".join(block.text for block in resp.content if block.type == "text").strip()
        parsed = _parse_json_array(text)
        intents = _sanitize_intents(parsed, limit)
        if intents:
            brief["_anthropic_used"] = True
        return intents
    except Exception as exc:
        print(f"live_candidate_intents: anthropic intent generation failed — {exc}")
        return []


def _parse_json_array(text: str) -> Any:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\[[\s\S]*\]", text)
        if not match:
            return []
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            return []


def _sanitize_intents(value: Any, limit: int) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    intents: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, dict):
            continue
        query = _clean_query(item.get("query"))
        if not query or query in seen:
            continue
        seen.add(query)
        intents.append(
            {
                "query": query,
                "label": _clean_label(item.get("label")) or "Live search",
                "reason": _clean_reason(item.get("reason")) or "Expanded beyond the local catalog.",
            }
        )
        if len(intents) >= limit:
            break
    return intents


def _heuristic_intents(brief: dict[str, Any], limit: int) -> list[dict[str, str]]:
    prompt = brief["prompt"]
    descriptors = brief["descriptors"]
    genres = brief["genres"] or ["indie", "alternative", "new music"]
    freshness = brief.get("freshness", "balanced")
    year_anchor = max(_CURRENT_YEAR - (1 if freshness == "newer" else 3), 2020)

    query_parts: list[tuple[str, str, str]] = []
    if prompt:
        query_parts.append((prompt, "Prompt expansion", "Uses your current search prompt outside the catalog."))
        if descriptors:
            query_parts.append(
                (
                    " ".join(descriptors[:4]),
                    "Mood expansion",
                    "Uses the musical descriptors inferred from your prompt.",
                )
            )

    for genre in genres[:8]:
        if freshness == "newer":
            query_parts.append((f"{genre} new releases", "Current search", f"Looks for fresher {genre} tracks."))
        query_parts.extend(
            [
                (f"{genre} new music", "Fresh genre search", f"Looks beyond the DB for current {genre} tracks."),
                (f"{genre} deep cuts", "Deep search", f"Looks for less-obvious {genre} tracks."),
                (f"{genre} {year_anchor}", "Recent search", f"Adds a recent-year angle for {genre}."),
            ]
        )

    intents: list[dict[str, str]] = []
    seen: set[str] = set()
    for query, label, reason in query_parts:
        clean = _clean_query(query)
        if not clean or clean in seen:
            continue
        seen.add(clean)
        intents.append({"query": clean, "label": label, "reason": reason})
        if len(intents) >= limit:
            break
    return intents


def _clean_query(value: Any) -> str:
    clean = re.sub(r"\s+", " ", str(value or "").strip())
    clean = re.sub(r"^[\"'`]+|[\"'`]+$", "", clean)
    if len(clean) < 3:
        return ""
    return clean[:90]


def _clean_label(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())[:48]


def _clean_reason(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())[:160]
