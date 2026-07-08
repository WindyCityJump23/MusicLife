"""Personal mood presets derived from the user's own taste clusters.

The multi-centroid taste model (taste_model.cluster_taste_vectors) discovers
a listener's distinct taste modes. This service turns each mode into a
one-tap preset: its top genres become the steering prompt, its anchor
artists ground the label, and Claude names it when an Anthropic key is
configured ("Your late-night electronic side") with a deterministic
fallback ("Your dream pop side") otherwise — so the feature ships without
the key and upgrades automatically when it lands.

The derivation from cluster members is a pure function (unit-tested);
only the data fetch and the optional Claude call touch the outside world.
"""

from __future__ import annotations

import json
import math
import re
from collections import Counter

from supabase import Client

from app.services.ranking import weighted_library_embedding_rows
from app.services.taste_model import cluster_taste_vectors

MAX_PRESETS = 3
_MIN_CLUSTER_MEMBERS = 4
_TOP_ARTISTS_PER_CLUSTER = 3
_TOP_GENRES_PER_CLUSTER = 3

# Tags that make bad prompt/label material.
_GENRE_STOPWORDS = {
    "seen live", "favorites", "favorite", "spotify", "check", "usa",
    "american", "uk", "british", "canada", "australia", "male vocalists",
    "female vocalists", "all",
}


def _norm(vec: list[float]) -> list[float]:
    magnitude = math.sqrt(sum(v * v for v in vec))
    return [v / magnitude for v in vec] if magnitude else list(vec)


def _cos(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


def derive_preset_definitions(cluster_members: list[list[dict]]) -> list[dict]:
    """Turn per-cluster member lists into preset definitions (pure).

    Each member: {"name": str, "genres": list[str], "weight": float}.
    Returns [{label, prompt, top_genres, top_artists}] — label is the
    deterministic fallback; callers may overwrite it with a Claude name.
    """
    presets: list[dict] = []
    seen_prompts: set[str] = set()

    for members in cluster_members:
        if len(members) < _MIN_CLUSTER_MEMBERS:
            continue

        genre_weights: Counter[str] = Counter()
        for member in members:
            for genre in member.get("genres") or []:
                g = str(genre).strip().lower()
                if g and g not in _GENRE_STOPWORDS:
                    genre_weights[g] += float(member.get("weight") or 1.0)

        top_genres = [g for g, _ in genre_weights.most_common(_TOP_GENRES_PER_CLUSTER)]
        top_artists = [
            str(m.get("name") or "").strip()
            for m in sorted(members, key=lambda m: float(m.get("weight") or 0.0), reverse=True)
            if m.get("name")
        ][:_TOP_ARTISTS_PER_CLUSTER]

        if top_genres:
            prompt = " ".join(top_genres[:2])
            label = f"Your {top_genres[0]} side"
        elif top_artists:
            prompt = f"like {' and '.join(top_artists[:2])}"
            label = f"Your {top_artists[0]} side"
        else:
            continue

        if prompt in seen_prompts:
            continue
        seen_prompts.add(prompt)

        presets.append(
            {
                "label": _title_case(label),
                "prompt": prompt,
                "top_genres": top_genres,
                "top_artists": top_artists,
            }
        )

    return presets[:MAX_PRESETS]


def _title_case(text: str) -> str:
    return re.sub(r"\b([a-z])", lambda m: m.group(1).upper(), text)


def build_personal_presets(client: Client, user_id: str) -> list[dict]:
    """Cluster the user's library and derive personal presets."""
    rows = weighted_library_embedding_rows(client, user_id)
    if len(rows) < 2 * _MIN_CLUSTER_MEMBERS:
        return []

    vectors = [vec for _, vec, _ in rows]
    weights = [w for _, _, w in rows]
    clusters = cluster_taste_vectors(vectors, weights, k=MAX_PRESETS)
    if len(clusters) < 2:
        # A single taste mode doesn't need "sides" — curated presets suffice.
        return []

    normalized_clusters = [_norm(c) for c in clusters]
    memberships: list[list[int]] = [[] for _ in clusters]
    for idx, (_, vec, _) in enumerate(rows):
        nvec = _norm(vec)
        best = max(range(len(normalized_clusters)), key=lambda c: _cos(nvec, normalized_clusters[c]))
        memberships[best].append(idx)

    # Fetch names/genres for every member we might describe.
    member_ids = sorted({rows[i][0] for cluster in memberships for i in cluster})
    artists_by_id: dict[int, dict] = {}
    for start in range(0, len(member_ids), 200):
        chunk = member_ids[start : start + 200]
        resp = (
            client.table("artists")
            .select("id,name,genres")
            .in_("id", chunk)
            .execute()
        )
        for row in resp.data or []:
            if row.get("id") is not None:
                artists_by_id[int(row["id"])] = row

    cluster_members: list[list[dict]] = []
    for cluster in memberships:
        members = []
        for idx in cluster:
            artist_id, _, weight = rows[idx]
            info = artists_by_id.get(artist_id) or {}
            members.append(
                {
                    "name": info.get("name"),
                    "genres": info.get("genres") or [],
                    "weight": weight,
                }
            )
        cluster_members.append(members)

    presets = derive_preset_definitions(cluster_members)
    if not presets:
        return []

    _apply_claude_labels(presets)

    return [
        {
            "id": f"personal-{i + 1}",
            "label": preset["label"],
            "prompt": preset["prompt"],
            "personal": True,
        }
        for i, preset in enumerate(presets)
    ]


def _apply_claude_labels(presets: list[dict]) -> None:
    """Overwrite fallback labels with Claude-written ones when possible.

    Best-effort: any failure (missing key, model error, unparseable output)
    leaves the deterministic labels in place.
    """
    try:
        from app.config import settings

        if not settings.anthropic_api_key or settings.anthropic_api_key.startswith("placeholder"):
            return
        from anthropic import Anthropic

        descriptions = [
            {
                "genres": preset["top_genres"],
                "artists": preset["top_artists"],
            }
            for preset in presets
        ]
        # Same client/model pattern as routes/synthesize.py.
        client = Anthropic(api_key=settings.anthropic_api_key)
        resp = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=300,
            system=(
                "You name personal radio presets from a listener's taste clusters. "
                "Given clusters (genres + anchor artists), return ONLY a JSON array "
                "of short evocative names, one per cluster, each starting with 'Your' "
                "and at most 5 words, e.g. \"Your Late-Night Electronic Side\". "
                "No hype, no explanations."
            ),
            messages=[{"role": "user", "content": json.dumps(descriptions)}],
        )
        text = "".join(block.text for block in resp.content if block.type == "text").strip()
        match = re.search(r"\[.*\]", text, re.DOTALL)
        if not match:
            return
        labels = json.loads(match.group(0))
        for preset, label in zip(presets, labels):
            if isinstance(label, str) and label.strip():
                preset["label"] = label.strip()[:48]
    except Exception as exc:
        print(f"taste_presets: Claude labeling skipped (non-fatal): {exc}")
