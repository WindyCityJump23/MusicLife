"""
Claude writes the "why this artist, why now" paragraph shown on each
recommendation card. Inputs: the artist, the user's top affinity anchors,
the specific mentions that drove the editorial score, the user's prompt.

The goal is grounded synthesis — it should feel like a knowledgeable friend
telling you why you'd like something, citing specific evidence, not a
marketing blurb.
"""
from anthropic import Anthropic
from fastapi import APIRouter
from pydantic import BaseModel

from app.config import settings

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


SYSTEM = """You write short, grounded recommendation blurbs for a personal music dashboard.
One paragraph, 3-5 sentences. Name the specific connection to the user's existing taste.
Quote or paraphrase a phrase from the supplied editorial excerpts if one is apt.
No hype language. No 'fans of X will love Y'. Calm, specific, trustworthy."""


@router.post("", response_model=SynthResponse)
def synthesize(req: SynthRequest):
    user_msg = _format_context(req)
    resp = client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=400,
        system=SYSTEM,
        messages=[{"role": "user", "content": user_msg}],
    )
    text = "".join(b.text for b in resp.content if b.type == "text")
    return SynthResponse(paragraph=text.strip())


def _format_context(req: SynthRequest) -> str:
    lines = [f"Artist: {req.artist_name}"]
    if req.artist_tags:
        lines.append(f"Tags: {', '.join(req.artist_tags)}")
    lines.append(f"User's closest existing artists: {', '.join(req.anchor_artists)}")
    if req.prompt:
        lines.append(f"User's current prompt: {req.prompt}")
    if req.mentions:
        lines.append("Recent editorial coverage:")
        for m in req.mentions[:3]:
            lines.append(f"- {m.get('source')}: \"{m.get('excerpt')}\"")
    return "\n".join(lines)
