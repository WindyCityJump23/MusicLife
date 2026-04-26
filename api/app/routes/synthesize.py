"""
Claude writes the "why this artist, why now" paragraph shown on each
recommendation card. Inputs: the artist, the user's top affinity anchors,
the specific mentions that drove the editorial score, the user's prompt.

The goal is grounded synthesis — it should feel like a knowledgeable friend
telling you why you'd like something, citing specific evidence, not a
marketing blurb.

Two endpoints:
  POST /synthesize             — caller supplies the context; pure LLM call.
  POST /synthesize/for-artist  — server gathers context from Supabase, then
                                  calls the same prompt path.
"""
from __future__ import annotations

import math

from anthropic import Anthropic
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.config import settings
from app.services.supabase_client import admin_supabase

router = APIRouter()
client = Anthropic(api_key=settings.anthropic_api_key)


class SynthRequest(BaseModel):
    artist_name: str
    artist_tags: list[str]
    anchor_artists: list[str]  # top 3 library artists closest to this one
    mentions: list[dict]  # [{source, excerpt, published_at}, ...]
    prompt: str | None = None


class SynthResponse(BaseModel):
    paragraph: str


class SynthForArtistRequest(BaseModel):
    user_id: str
    artist_id: int
    prompt: str | None = None


SYSTEM = """You write short, grounded recommendation blurbs for a personal music dashboard.
One paragraph, 3-5 sentences. Name the specific connection to the user's existing taste.
Quote or paraphrase a phrase from the supplied editorial excerpts if one is apt.
No hype language. No 'fans of X will love Y'. Calm, specific, trustworthy."""


@router.post("", response_model=SynthResponse)
def synthesize(req: SynthRequest):
    return SynthResponse(paragraph=_call_claude(req))


@router.post("/for-artist", response_model=SynthResponse)
def synthesize_for_artist(req: SynthForArtistRequest):
    context = _build_context(req.user_id, req.artist_id, req.prompt)
    if context is None:
        raise HTTPException(status_code=404, detail="artist not found or has no embedding")
    return SynthResponse(paragraph=_call_claude(context))


# ---------------------------------------------------------------------------
# Anthropic call
# ---------------------------------------------------------------------------


def _call_claude(req: SynthRequest) -> str:
    user_msg = _format_context(req)
    resp = client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=400,
        system=SYSTEM,
        messages=[{"role": "user", "content": user_msg}],
    )
    text = "".join(b.text for b in resp.content if b.type == "text")
    return text.strip()


def _format_context(req: SynthRequest) -> str:
    lines = [f"Artist: {req.artist_name}"]
    if req.artist_tags:
        lines.append(f"Tags: {', '.join(req.artist_tags)}")
    if req.anchor_artists:
        lines.append(f"User's closest existing artists: {', '.join(req.anchor_artists)}")
    if req.prompt:
        lines.append(f"User's current prompt: {req.prompt}")
    if req.mentions:
        lines.append("Recent editorial coverage:")
        for m in req.mentions[:3]:
            lines.append(f"- {m.get('source')}: \"{m.get('excerpt')}\"")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Context gathering
# ---------------------------------------------------------------------------


def _build_context(user_id: str, artist_id: int, prompt: str | None) -> SynthRequest | None:
    artist_resp = (
        admin_supabase.table("artists")
        .select("id, name, genres, embedding")
        .eq("id", artist_id)
        .limit(1)
        .execute()
    )
    artist_rows = artist_resp.data or []
    if not artist_rows:
        return None
    artist = artist_rows[0]

    candidate_vec = _parse_vector(artist.get("embedding"))
    anchors = _top_anchor_artists(user_id, candidate_vec) if candidate_vec else []
    mentions = _recent_mentions(artist_id)

    return SynthRequest(
        artist_name=artist.get("name") or "Unknown artist",
        artist_tags=list(artist.get("genres") or []),
        anchor_artists=anchors,
        mentions=mentions,
        prompt=prompt,
    )


def _top_anchor_artists(user_id: str, candidate_vec: list[float], top_n: int = 3) -> list[str]:
    """Return the top N library artists most similar to the candidate."""
    user_tracks_resp = (
        admin_supabase.table("user_tracks")
        .select("track_id")
        .eq("user_id", user_id)
        .execute()
    )
    user_tracks = user_tracks_resp.data or []
    track_ids = [r["track_id"] for r in user_tracks if r.get("track_id") is not None]
    if not track_ids:
        return []

    tracks_resp = (
        admin_supabase.table("tracks")
        .select("id, artist_id")
        .in_("id", track_ids)
        .execute()
    )
    artist_ids = {
        r["artist_id"]
        for r in (tracks_resp.data or [])
        if r.get("artist_id") is not None
    }
    if not artist_ids:
        return []

    artists_resp = (
        admin_supabase.table("artists")
        .select("id, name, embedding")
        .in_("id", list(artist_ids))
        .execute()
    )

    scored: list[tuple[float, str]] = []
    for a in artists_resp.data or []:
        vec = _parse_vector(a.get("embedding"))
        if not vec:
            continue
        scored.append((_cosine(candidate_vec, vec), a.get("name") or "Unknown"))

    scored.sort(key=lambda t: t[0], reverse=True)
    return [name for _, name in scored[:top_n]]


def _recent_mentions(artist_id: int, limit: int = 3) -> list[dict]:
    resp = (
        admin_supabase.table("mentions")
        .select("excerpt, published_at, source_id")
        .eq("artist_id", artist_id)
        .order("published_at", desc=True)
        .limit(limit)
        .execute()
    )
    rows = resp.data or []
    if not rows:
        return []

    source_ids = list({r["source_id"] for r in rows if r.get("source_id") is not None})
    source_names: dict[int, str] = {}
    if source_ids:
        sources_resp = (
            admin_supabase.table("sources")
            .select("id, name")
            .in_("id", source_ids)
            .execute()
        )
        source_names = {r["id"]: r["name"] for r in (sources_resp.data or [])}

    return [
        {
            "source": source_names.get(r.get("source_id"), "unknown"),
            "excerpt": r.get("excerpt"),
            "published_at": r.get("published_at"),
        }
        for r in rows
    ]


# ---------------------------------------------------------------------------
# Math helpers (lightweight; ranking.py has the canonical versions)
# ---------------------------------------------------------------------------


def _parse_vector(value: object) -> list[float]:
    if value is None:
        return []
    if isinstance(value, list):
        return [float(x) for x in value]
    if isinstance(value, str):
        text = value.strip()
        if text.startswith("[") and text.endswith("]"):
            body = text[1:-1].strip()
            if not body:
                return []
            return [float(part) for part in body.split(",")]
    return []


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)
