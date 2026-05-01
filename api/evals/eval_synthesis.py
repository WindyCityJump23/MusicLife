"""Evals for the Claude synthesis engine (synthesize.py).

Two tiers:

  Tier 1 — Heuristic checks (no API key required, always run):
    • No hype language (banned word list)
    • Length: 3–5 sentences
    • Anchor artist reference: blurb mentions at least one anchor
    • Source grounding: claims citation if mentions were provided

  Tier 2 — LLM-as-judge (requires ANTHROPIC_API_KEY):
    • Groundedness: a second Claude call rates whether every claim in
      the blurb is traceable to the supplied context (1–5 scale).
    • Tone: rates whether the blurb feels like "a knowledgeable friend"
      rather than a marketing pitch (1–5 scale).

Tier 2 evals are skipped (not failed) when the API key is absent so that
the eval suite runs cleanly in CI without credentials.
"""
from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

_API_DIR = Path(__file__).parent.parent
if str(_API_DIR) not in sys.path:
    sys.path.insert(0, str(_API_DIR))

# Stub out required env vars so app.config.Settings() doesn't raise at import
# time when credentials are not present (CI / offline eval runs).
_STUBS = {
    "SUPABASE_URL": "https://stub.supabase.co",
    "SUPABASE_SERVICE_ROLE_KEY": "stub",
    "SUPABASE_ANON_KEY": "stub",
    "ANTHROPIC_API_KEY": os.environ.get("ANTHROPIC_API_KEY", "placeholder-key"),
    "LASTFM_API_KEY": "stub",
    "MUSICBRAINZ_USER_AGENT": "MusicLifeEvals/1.0",
}
for _k, _v in _STUBS.items():
    os.environ.setdefault(_k, _v)

# synthesize._format_context is imported for the context-formatting unit test.
from app.routes.synthesize import SynthRequest, _format_context


@dataclass
class EvalResult:
    name: str
    passed: bool
    score: float
    details: str = ""
    skipped: bool = False
    threshold: float = 1.0


# ── Shared test fixture ──────────────────────────────────────────

_SAMPLE_REQUEST = SynthRequest(
    artist_name="Nubya Garcia",
    artist_tags=["jazz", "uk jazz", "saxophone"],
    anchor_artists=["Shabaka Hutchings", "Moses Boyd", "Ezra Collective"],
    mentions=[
        {
            "source": "Pitchfork",
            "excerpt": "Garcia's tenor saxophone work feels both rooted in tradition and urgently contemporary.",
            "published_at": "2024-03-10",
        },
        {
            "source": "The Wire",
            "excerpt": "A singular voice in the UK jazz renaissance.",
            "published_at": "2024-01-22",
        },
    ],
    prompt="late night improvised jazz",
)

_HYPE_WORDS = [
    "amazing", "incredible", "stunning", "unbelievable", "phenomenal",
    "mind-blowing", "breathtaking", "legendary", "epic", "revolutionary",
    "game-changer", "groundbreaking", "must-listen", "essential",
]


# ── Heuristic evals (no API key needed) ─────────────────────────


def eval_no_hype_language(blurb: str) -> EvalResult:
    """Blurb should not contain marketing-style superlatives.

    The system prompt forbids "hype language" — we check for the most
    common offenders with a simple word-boundary search.
    """
    found = [w for w in _HYPE_WORDS if re.search(rf"\b{w}\b", blurb, re.IGNORECASE)]
    passed = len(found) == 0
    return EvalResult(
        name="no_hype_language",
        passed=passed,
        score=1.0 if passed else max(0.0, 1.0 - len(found) * 0.25),
        details=f"Hype words found: {found or 'none'}",
    )


def eval_length_3_to_5_sentences(blurb: str) -> EvalResult:
    """Blurb should be 3–5 sentences (system prompt specifies 'one paragraph, 3-5 sentences')."""
    # Split on sentence-ending punctuation followed by whitespace or end-of-string
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", blurb.strip()) if s.strip()]
    n = len(sentences)
    passed = 3 <= n <= 5
    score = 1.0 if passed else max(0.0, 1.0 - abs(n - 4) * 0.3)
    return EvalResult(
        name="length_3_to_5_sentences",
        passed=passed,
        score=round(score, 4),
        details=f"Sentence count: {n}. Full blurb: {blurb[:120]}{'...' if len(blurb)>120 else ''}",
    )


def eval_anchor_artist_referenced(blurb: str, request: SynthRequest) -> EvalResult:
    """Blurb should name at least one of the user's anchor artists.

    The system prompt says "Name the specific connection to the user's
    existing taste." We verify this is operationalized by checking that at
    least one anchor artist's name (or a recognizable abbreviation) appears.
    """
    blurb_lower = blurb.lower()
    matched = [a for a in request.anchor_artists if a.split()[0].lower() in blurb_lower]
    passed = len(matched) >= 1
    score = min(1.0, len(matched) / max(len(request.anchor_artists), 1))
    return EvalResult(
        name="anchor_artist_referenced",
        passed=passed,
        score=round(score, 4),
        details=f"Anchors matched in blurb: {matched or 'none'} out of {request.anchor_artists}",
    )


def eval_editorial_quote_present(blurb: str, request: SynthRequest) -> EvalResult:
    """When mentions contain quotable excerpts, the blurb should cite or paraphrase one.

    The system prompt says 'Quote or paraphrase a phrase from the supplied
    editorial excerpts if one is apt.' We look for quoted text or distinctive
    phrasing from the provided excerpts.
    """
    if not request.mentions:
        return EvalResult(
            name="editorial_quote_present",
            passed=True,
            score=1.0,
            details="No mentions provided — criterion not applicable",
        )
    # Check for any fragment from the excerpts appearing verbatim or near-verbatim
    blurb_lower = blurb.lower()
    def _excerpt_echoed(excerpt: str) -> bool:
        words = excerpt.split()
        return any(
            " ".join(words[i : i + 4]).lower() in blurb_lower
            for i in range(max(0, len(words) - 3))
        )

    any_echo = any(
        _excerpt_echoed(m["excerpt"])
        for m in request.mentions
        if m.get("excerpt")
    )
    # Also accept a direct quote marker
    has_quote = '"' in blurb or "'" in blurb
    passed = any_echo or has_quote
    return EvalResult(
        name="editorial_quote_present",
        passed=passed,
        score=1.0 if passed else 0.5,  # softer — paraphrase is acceptable
        details=f"Editorial echo found: {any_echo}, quote marks present: {has_quote}",
        threshold=0.5,
    )


def eval_format_context_includes_all_fields() -> EvalResult:
    """_format_context should include all non-empty fields from SynthRequest.

    This is a unit test for the prompt-building logic: ensures nothing
    gets silently dropped before the LLM sees it.
    """
    formatted = _format_context(_SAMPLE_REQUEST)
    checks = {
        "artist_name": _SAMPLE_REQUEST.artist_name in formatted,
        "tags": all(tag in formatted for tag in _SAMPLE_REQUEST.artist_tags[:2]),
        "anchor_artists": _SAMPLE_REQUEST.anchor_artists[0] in formatted,
        "prompt": (_SAMPLE_REQUEST.prompt or "") in formatted,
        "mention_source": _SAMPLE_REQUEST.mentions[0]["source"] in formatted,
        "mention_excerpt": _SAMPLE_REQUEST.mentions[0]["excerpt"][:20] in formatted,
    }
    failed = [k for k, v in checks.items() if not v]
    passed = len(failed) == 0
    score = (len(checks) - len(failed)) / len(checks)
    return EvalResult(
        name="format_context_includes_all_fields",
        passed=passed,
        score=round(score, 4),
        details=f"Missing fields: {failed or 'none'}",
    )


# ── LLM-as-judge evals (require API key) ────────────────────────


_SENTINEL_MISSING = "__KEY_MISSING__"


def _call_judge(prompt: str, max_tokens: int = 200) -> Optional[str]:
    """Call Claude to act as a judge.

    Returns None when API key is absent and --require-llm is not set.
    Returns _SENTINEL_MISSING when key is absent and --require-llm is set.
    """
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key or api_key.startswith("placeholder"):
        if os.environ.get("MUSICLIFE_REQUIRE_LLM"):
            return _SENTINEL_MISSING
        return None
    try:
        import anthropic
        client = anthropic.Anthropic(api_key=api_key)
        resp = client.messages.create(
            model="claude-haiku-4-5-20251001",  # fast + cheap for judging
            max_tokens=max_tokens,
            messages=[{"role": "user", "content": prompt}],
        )
        return "".join(b.text for b in resp.content if b.type == "text").strip()
    except Exception as exc:
        return f"ERROR: {exc}"


def eval_llm_groundedness(blurb: str, request: SynthRequest) -> EvalResult:
    """Claude-as-judge rates whether every blurb claim is traceable to provided context.

    Score 1–5:
      5 = every claim has a clear source in the context
      3 = one or two unsupported details
      1 = mostly fabricated
    Threshold to pass: ≥ 4.
    """
    context = _format_context(request)
    judge_prompt = f"""You are evaluating a music recommendation blurb for factual groundedness.

CONTEXT PROVIDED TO THE WRITER:
{context}

BLURB TO EVALUATE:
{blurb}

Rate groundedness on a scale of 1–5:
5 = Every claim and comparison is directly traceable to the provided context.
4 = Nearly all claims are grounded; one minor embellishment.
3 = Most claims grounded but one unsupported assertion.
2 = Several claims that go beyond the context.
1 = Mostly hallucinated — context mostly ignored.

Respond with ONLY a single integer (1–5) and one sentence explaining your rating."""

    response = _call_judge(judge_prompt)
    if response is None:
        return EvalResult(
            name="llm_groundedness",
            passed=True,
            score=1.0,
            skipped=True,
            details="Skipped — ANTHROPIC_API_KEY not set",
        )
    if response == _SENTINEL_MISSING:
        return EvalResult(
            name="llm_groundedness",
            passed=False,
            score=0.0,
            details="FAILED — ANTHROPIC_API_KEY required by --require-llm but not set",
        )
    if response.startswith("ERROR:"):
        return EvalResult(
            name="llm_groundedness",
            passed=False,
            score=0.0,
            details=response,
        )
    match = re.search(r"\b([1-5])\b", response)
    rating = int(match.group(1)) if match else 3
    score = (rating - 1) / 4.0
    passed = rating >= 4
    return EvalResult(
        name="llm_groundedness",
        passed=passed,
        score=round(score, 4),
        details=f"Judge rating: {rating}/5. Response: {response[:200]}",
        threshold=0.75,
    )


def eval_llm_tone(blurb: str) -> EvalResult:
    """Claude-as-judge rates whether the blurb sounds like a knowledgeable friend, not a PR pitch.

    Score 1–5:
      5 = calm, specific, trustworthy — feels like personal music knowledge
      3 = partially promotional but has substance
      1 = pure marketing copy
    Threshold to pass: ≥ 4.
    """
    judge_prompt = f"""You are evaluating the tone of a music recommendation blurb.

The ideal tone is: a knowledgeable friend sharing a specific, calm, evidence-based recommendation.
The worst tone is: a marketing blurb with superlatives and empty hype.

BLURB:
{blurb}

Rate tone on a scale of 1–5:
5 = Reads like a trusted friend sharing genuine insight. Specific, calm, grounded.
4 = Mostly conversational with minor overpromising.
3 = Mixed — has good moments but slips into promo language.
2 = Mostly promotional, few specific claims.
1 = Pure hype / marketing copy.

Respond with ONLY a single integer (1–5) and one sentence explaining your rating."""

    response = _call_judge(judge_prompt)
    if response is None:
        return EvalResult(
            name="llm_tone",
            passed=True,
            score=1.0,
            skipped=True,
            details="Skipped — ANTHROPIC_API_KEY not set",
        )
    if response == _SENTINEL_MISSING:
        return EvalResult(
            name="llm_tone",
            passed=False,
            score=0.0,
            details="FAILED — ANTHROPIC_API_KEY required by --require-llm but not set",
        )
    if response.startswith("ERROR:"):
        return EvalResult(name="llm_tone", passed=False, score=0.0, details=response)
    match = re.search(r"\b([1-5])\b", response)
    rating = int(match.group(1)) if match else 3
    score = (rating - 1) / 4.0
    passed = rating >= 4
    return EvalResult(
        name="llm_tone",
        passed=passed,
        score=round(score, 4),
        details=f"Judge rating: {rating}/5. Response: {response[:200]}",
        threshold=0.75,
    )


# ── Suite runner ─────────────────────────────────────────────────


def _get_sample_blurb() -> Optional[str]:
    """Generate a blurb using the live API, or return a canned blurb for heuristic tests."""
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key or api_key.startswith("placeholder"):
        # Canned blurb that represents realistic output — heuristic evals
        # can still run in CI without a real API call.
        return (
            "Nubya Garcia shares the UK jazz scene that shaped artists you already love "
            "like Shabaka Hutchings and Moses Boyd. Her tenor saxophone work, described "
            "by Pitchfork as 'rooted in tradition and urgently contemporary,' makes her "
            "a natural fit for late-night listening. Garcia builds unhurried, searching "
            "improvisations that reward attention without demanding it."
        )
    try:
        import anthropic
        from app.routes.synthesize import SYSTEM, _format_context

        client = anthropic.Anthropic(api_key=api_key)
        resp = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=400,
            system=SYSTEM,
            messages=[{"role": "user", "content": _format_context(_SAMPLE_REQUEST)}],
        )
        return "".join(b.text for b in resp.content if b.type == "text").strip()
    except Exception:
        return None


def run_suite() -> list[EvalResult]:
    blurb = _get_sample_blurb()
    if blurb is None:
        return [
            EvalResult(
                name="synthesis_suite",
                passed=False,
                score=0.0,
                details="Could not generate or load a sample blurb",
            )
        ]

    results = [
        eval_no_hype_language(blurb),
        eval_length_3_to_5_sentences(blurb),
        eval_anchor_artist_referenced(blurb, _SAMPLE_REQUEST),
        eval_editorial_quote_present(blurb, _SAMPLE_REQUEST),
        eval_format_context_includes_all_fields(),
        eval_llm_groundedness(blurb, _SAMPLE_REQUEST),
        eval_llm_tone(blurb),
    ]
    return results
