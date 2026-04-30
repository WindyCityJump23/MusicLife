"""Song-level recommendation engine.

Extends the artist-level ranking to produce individual song recommendations.
Uses artist embeddings as the foundation, then ranks individual tracks by
combining artist-level signals with track-specific metadata:

  song_score = artist_score × track_boost

Where track_boost incorporates:
  - Track popularity (Spotify's 0–100 normalized)
  - Recency bonus for recently released/played tracks
  - Explicit preference alignment
  - Familiarity penalty (reduce songs from the user's own library)

Results are deduplicated by track name (case-insensitive) and diversity-reranked.
"""

from __future__ import annotations

import math
import random
from collections import Counter, defaultdict
from datetime import datetime, timezone

from supabase import Client

from app.services.ranking import (
    _cosine_similarity,
    _diversity_rerank,
    _get_previously_recommended_artist_ids,
    _get_user_artist_weights,
    _normalize_01,
    _parse_vector,
    _percentile_rank,
    build_taste_vector,
)


def recommend_songs(
    client: Client,
    user_id: str,
    taste_vector: list[float],
    prompt_vector: list[float] | None,
    weights: dict[str, float],
    exclude_library: bool,
    limit: int,
    prompt_text: str | None = None,
) -> list[dict]:
    """Return a ranked list of song-level recommendations.

    If prompt_text looks like a genre (matches known genres in the DB),
    results are filtered to only include artists with matching genres.
    This makes searches like 'alternative rock' or 'hip-hop' work as
    genre filters rather than just embedding similarity.
    """

    artist_weights = _get_user_artist_weights(client, user_id)
    library_artist_ids = set(artist_weights.keys())
    previously_recommended = _get_previously_recommended_artist_ids(client, user_id)

    # ── Fetch all artists with embeddings ─────────────────────
    artists_resp = (
        client.table("artists")
        .select("id,name,embedding,popularity,genres,spotify_artist_id")
        .not_.is_("embedding", "null")
        .range(0, 9999)
        .execute()
    )
    all_artists = artists_resp.data or []

    # ── Genre filtering: if prompt looks like a genre, filter artists ──
    # Matching rules (in order of strictness):
    #   1. The full normalized prompt is a substring of a genre (e.g. "rock"
    #      matches "alt rock", "pop dance" matches "pop dance pop").
    #   2. A genre is a substring of the prompt (e.g. "lo-fi" matches a
    #      "chill lo-fi" prompt).
    #   3. EVERY prompt word appears (as a whole word or substring) in a
    #      single genre string. This requires "pop" AND "dance" to both
    #      live in the same genre — preventing "pop r&b" from matching
    #      "pop dance" via a single shared word.
    genre_filtered = False
    if prompt_text:
        prompt_lower = prompt_text.strip().lower()
        prompt_norm = prompt_lower.replace("-", " ").strip()
        prompt_words = [w for w in prompt_norm.split() if w]

        def _artist_matches_genre(artist: dict) -> bool:
            genres = artist.get("genres") or []
            for g in genres:
                gl = g.lower()
                gl_norm = gl.replace("-", " ")
                if prompt_norm and prompt_norm in gl_norm:
                    return True
                if gl_norm and gl_norm in prompt_norm:
                    return True
                if prompt_words and all(w in gl_norm for w in prompt_words):
                    return True
            return False

        matching = [a for a in all_artists if _artist_matches_genre(a)]
        # Only apply the filter if it produces a workable pool. Otherwise
        # fall back to embedding similarity over the full catalog so the
        # user always gets *some* recommendations.
        if len(matching) >= 5:
            all_artists = matching
            genre_filtered = True
            print(f"song_ranking: genre filter '{prompt_text}' matched {len(matching)} artists")
        else:
            print(
                f"song_ranking: genre filter '{prompt_text}' matched only "
                f"{len(matching)} artists — falling back to full catalog"
            )

    # ── Fetch user's track data for familiarity detection ─────
    user_tracks_resp = (
        client.table("user_tracks")
        .select("track_id,play_count,last_played_at")
        .eq("user_id", user_id)
        .range(0, 9999)
        .execute()
    )
    user_track_map: dict[int, dict] = {
        row["track_id"]: row
        for row in (user_tracks_resp.data or [])
        if row.get("track_id")
    }

    # ── Source/mention data for editorial + context signals ────
    candidate_ids = [int(a["id"]) for a in all_artists if a.get("id")]

    source_resp = (
        client.table("sources")
        .select("id,name,trust_weight")
        .range(0, 9999)
        .execute()
    )
    source_info: dict[int, dict] = {
        int(row["id"]): {
            "trust_weight": float(row.get("trust_weight") or 0.7),
            "name": row.get("name") or "",
        }
        for row in (source_resp.data or [])
        if row.get("id") is not None
    }

    if candidate_ids:
        mention_resp = (
            client.table("mentions")
            .select("artist_id,source_id,embedding,published_at,sentiment,excerpt")
            .in_("artist_id", candidate_ids)
            .range(0, 9999)
            .execute()
        )
    else:
        mention_resp = type("_R", (), {"data": []})()  # type: ignore
    mentions_by_artist: dict[int, list[dict]] = defaultdict(list)
    for m in (mention_resp.data or []):
        aid = m.get("artist_id")
        if aid is not None:
            mentions_by_artist[int(aid)].append(m)

    # ── Live web search augmentation (Tavily) ─────────────────
    # Fail-soft: if disabled, slow, or rate-limited, this is a no-op
    # and Discover proceeds with DB-only editorial coverage. When it
    # works, it adds fresh hits to the same `mentions_by_artist` map
    # the scoring loop already consumes — no math changes.
    web_artists_boosted: set[int] = set()
    if prompt_text:
        web_artists_boosted = _augment_with_web_search(
            prompt_text=prompt_text,
            all_artists=all_artists,
            mentions_by_artist=mentions_by_artist,
            source_info=source_info,
        )

    now = datetime.now(timezone.utc)
    recent_window_days = 45

    effective_prompt_vector = prompt_vector if prompt_vector else taste_vector
    has_explicit_prompt = prompt_vector is not None

    # ── Phase 1: Score each artist (same as artist-level engine) ─
    # NOTE: We include library artists in scoring (don't skip them)
    # because tracks in the DB mostly belong to library artists.
    # Instead, we apply a softer penalty to library-artist songs later.
    raw_affinities: list[tuple[dict, float]] = []
    for artist in all_artists:
        aid = artist.get("id")
        if aid is None:
            continue
        aid = int(aid)
        vec = _parse_vector(artist.get("embedding"))
        if not vec:
            continue
        raw = _cosine_similarity(taste_vector, vec)
        raw_affinities.append((artist, raw))

    raw_vals = [r for _, r in raw_affinities]
    pct_ranks = _percentile_rank(raw_vals)

    EXPLORATION_STRENGTH = 0.06

    artist_scores: dict[int, dict] = {}
    for idx, (artist, affinity_raw) in enumerate(raw_affinities):
        aid = int(artist["id"])
        # Blend percentile rank with raw cosine so the lowest-percentile
        # artist isn't displayed as a literal 0% match. Percentile keeps
        # the spread; the raw component provides a non-zero floor.
        if pct_ranks:
            affinity = 0.7 * pct_ranks[idx] + 0.3 * _normalize_01(affinity_raw)
        else:
            affinity = _normalize_01(affinity_raw)

        artist_mentions = mentions_by_artist.get(aid, [])
        context_scores: list[float] = []
        editorial_components: list[float] = []
        best_mention: dict | None = None
        best_mention_score = -1.0

        for mention in artist_mentions:
            mvec = _parse_vector(mention.get("embedding"))
            if effective_prompt_vector and mvec:
                context_scores.append(
                    _normalize_01(_cosine_similarity(effective_prompt_vector, mvec))
                )
            pub_raw = mention.get("published_at")
            recency_mult = 0.2
            if pub_raw:
                try:
                    pub_dt = datetime.fromisoformat(pub_raw.replace("Z", "+00:00"))
                    age = max((now - pub_dt).days, 0)
                    recency_mult = max(0.2, 1.0 - (age / recent_window_days))
                except ValueError:
                    recency_mult = 0.2

            src_id = int(mention.get("source_id") or 0)
            src = source_info.get(src_id, {"trust_weight": 0.7, "name": ""})
            sentiment = max(0.0, min(1.0, float(mention.get("sentiment") or 0.5)))
            component = src["trust_weight"] * recency_mult * (0.5 + 0.5 * sentiment)
            editorial_components.append(component)

            if component > best_mention_score and mention.get("excerpt"):
                best_mention_score = component
                best_mention = {
                    "source": src["name"],
                    "excerpt": mention.get("excerpt"),
                    "published_at": pub_raw,
                }

        context = max(context_scores) if context_scores else 0.0
        editorial = min(1.0, sum(editorial_components) / max(len(editorial_components), 1))

        base_score = (
            weights["affinity"] * affinity
            + weights["context"] * context
            + weights["editorial"] * editorial
        )

        if aid in previously_recommended:
            base_score *= 0.65

        artist_scores[aid] = {
            "base_score": base_score,
            "affinity": affinity,
            "context": context,
            "editorial": editorial,
            "name": artist.get("name") or "Unknown",
            "genres": list(artist.get("genres") or []),
            "best_mention": best_mention,
            "mention_count": len(artist_mentions),
            "spotify_artist_id": artist.get("spotify_artist_id"),
        }

    # ── Phase 2: Fetch tracks for top artists ────────────────────
    # Only expand songs for the top N artists to keep API calls manageable.
    top_artist_ids = sorted(
        artist_scores.keys(),
        key=lambda a: artist_scores[a]["base_score"],
        reverse=True,
    )[: limit * 8]  # Expand many more artists for diversity

    if not top_artist_ids:
        return []

    # Get tracks from DB for these artists (include audio features)
    tracks_resp = (
        client.table("tracks")
        .select("id,name,artist_id,album_name,duration_ms,popularity,spotify_track_id,explicit,energy,danceability,valence,tempo,acousticness,instrumentalness,speechiness")
        .in_("artist_id", top_artist_ids)
        .range(0, 9999)
        .execute()
    )
    all_tracks = tracks_resp.data or []

    # Group tracks by artist
    tracks_by_artist: dict[int, list[dict]] = defaultdict(list)
    for t in all_tracks:
        aid = t.get("artist_id")
        if aid is not None:
            tracks_by_artist[int(aid)].append(t)

    # ── Phase 3: Score individual songs ──────────────────────────
    song_results: list[dict] = []
    seen_songs: set[str] = set()

    for aid in top_artist_ids:
        a_info = artist_scores.get(aid)
        if not a_info:
            continue

        tracks = tracks_by_artist.get(aid, [])
        if not tracks:
            continue

        # Sort tracks by popularity descending, take top 2 per artist.
        # The diversity re-ranker caps the final output at 1 per artist,
        # so 2 candidates per artist is plenty and prevents a single
        # artist from flooding the pre-rerank pool with near-duplicate
        # versions of the same song (e.g. radio edits, deluxe cuts).
        tracks.sort(key=lambda t: t.get("popularity") or 0, reverse=True)
        tracks = tracks[:2]

        for track in tracks:
            track_name = (track.get("name") or "").strip()
            dedup_key = f"{track_name.lower()}|{a_info['name'].lower()}"
            if dedup_key in seen_songs:
                continue
            seen_songs.add(dedup_key)

            track_id = track.get("id")
            track_pop = float(track.get("popularity") or 50) / 100.0

            # Track-level boost: popularity + audio feature match
            track_boost = 0.7 + (0.3 * track_pop)  # 0.7–1.0 range

            # Familiarity: penalize songs the user has already heard,
            # but welcome NEW songs from familiar artists (deep cuts are
            # valuable discoveries even from artists you already know).
            in_library = track_id in user_track_map if track_id else False
            is_library_artist = aid in library_artist_ids
            if in_library:
                track_boost *= 0.45  # Strong penalty — you've already heard this exact song
            elif is_library_artist:
                track_boost *= 0.90  # Very mild — new song from a known artist = great find

            # Exploration
            exploration = random.uniform(-EXPLORATION_STRENGTH, EXPLORATION_STRENGTH)

            final_score = a_info["base_score"] * track_boost + exploration

            # Build reasons
            reasons = []
            if a_info["affinity"] > 0.55:
                reasons.append("Matches your taste")
            if a_info["context"] > 0.55:
                reasons.append("Matches your search" if has_explicit_prompt else "Fits your vibe")
            if a_info["editorial"] > 0.45:
                src_name = (
                    a_info["best_mention"]["source"]
                    if a_info["best_mention"] and a_info["best_mention"].get("source")
                    else ""
                )
                reasons.append(f"Featured in {src_name}" if src_name else "In the press")
            if aid in web_artists_boosted:
                reasons.append("Trending in live results")
            if track_pop > 0.7:
                reasons.append("Popular track")
            if in_library:
                reasons.append("Already in your library")
            elif is_library_artist and not in_library:
                reasons.append("Deep cut from an artist you love")
            if not reasons:
                reasons.append("Curated pick")

            song_results.append({
                "track_id": str(track_id) if track_id else None,
                "track_name": track_name,
                "artist_id": str(aid),
                "artist_name": a_info["name"],
                "album_name": track.get("album_name") or "",
                "duration_ms": track.get("duration_ms") or 0,
                "explicit": track.get("explicit") or False,
                "spotify_track_id": track.get("spotify_track_id") or "",
                "score": round(max(0.0, final_score), 4),
                "signals": {
                    "affinity": round(a_info["affinity"], 4),
                    "context": round(a_info["context"], 4),
                    "editorial": round(a_info["editorial"], 4),
                    "track_popularity": round(track_pop, 4),
                },
                "genres": a_info["genres"],
                "reasons": reasons,
                "mention_count": a_info["mention_count"],
                "top_mention": a_info["best_mention"],
            })

    # Sort by score
    song_results.sort(key=lambda s: s["score"], reverse=True)

    # ── Genre diversity re-ranking ───────────────────────────────
    diverse = _song_diversity_rerank(song_results, max(limit, 0))

    return diverse


def _song_diversity_rerank(scored: list[dict], limit: int) -> list[dict]:
    """Re-rank songs for genre + artist diversity.

    The artist cap is enforced unconditionally — even when the input pool
    is smaller than `limit`, we still need to drop near-duplicate songs
    from the same artist (e.g. multiple radio edits of the same track).
    """
    if not scored or limit <= 0:
        return []

    # Use the full pool when small, otherwise widen it to give the
    # greedy selector room to diversify.
    pool = scored if len(scored) <= limit else scored[: limit * 3]
    selected: list[dict] = []
    genre_counts: Counter[str] = Counter()
    artist_counts: Counter[str] = Counter()
    used: set[str] = set()

    MAX_GENRE_FRACTION = 0.3
    MAX_ARTIST_SONGS = 1  # One song per artist — maximize diversity

    while len(selected) < limit and pool:
        best_idx = -1
        best_adjusted = -1.0

        for i, candidate in enumerate(pool):
            key = f"{candidate['track_name']}|{candidate['artist_name']}".lower()
            if key in used:
                continue

            base = candidate["score"]
            genres = candidate.get("genres") or []
            primary_genre = genres[0].lower() if genres else "__none__"
            artist = candidate["artist_name"].lower()

            # Artist cap
            if artist_counts.get(artist, 0) >= MAX_ARTIST_SONGS:
                continue

            # Genre diversity penalty
            genre_share = genre_counts.get(primary_genre, 0) / max(len(selected), 1)
            penalty = 0.7 if genre_share >= MAX_GENRE_FRACTION else 1.0

            adjusted = base * penalty
            if adjusted > best_adjusted:
                best_adjusted = adjusted
                best_idx = i

        if best_idx < 0:
            break

        pick = pool[best_idx]
        key = f"{pick['track_name']}|{pick['artist_name']}".lower()
        selected.append(pick)
        used.add(key)

        genres = pick.get("genres") or []
        primary_genre = genres[0].lower() if genres else "__none__"
        genre_counts[primary_genre] += 1
        artist_counts[pick["artist_name"].lower()] += 1

    # ── Top-up pass ──────────────────────────────────────────────
    # If the strict 1-per-artist cap left us short of the target (sparse
    # catalog), relax the cap to 2 and fill from remaining candidates.
    # This is preferable to returning a near-empty result set when the
    # user's library is small or track population is still in progress.
    if len(selected) < limit:
        for candidate in pool:
            if len(selected) >= limit:
                break
            key = f"{candidate['track_name']}|{candidate['artist_name']}".lower()
            if key in used:
                continue
            artist = candidate["artist_name"].lower()
            if artist_counts.get(artist, 0) >= 2:
                continue
            selected.append(candidate)
            used.add(key)
            artist_counts[artist] += 1

    return selected


def _augment_with_web_search(
    prompt_text: str,
    all_artists: list[dict],
    mentions_by_artist: dict[int, list[dict]],
    source_info: dict[int, dict],
) -> set[int]:
    """Pull live web results, embed them, inject as synthetic mentions.

    Returns the set of artist_ids that were boosted by web results — used
    by the caller to surface a "Trending in live results" reason.

    Fail-soft: any failure (Tavily disabled / down / timeout / Voyage
    error) returns an empty set and leaves `mentions_by_artist` unchanged.
    """
    from app.services import web_search
    from app.services.embedding import embedder

    if not web_search.is_enabled():
        return set()

    try:
        results = web_search.search(prompt_text, limit=5)
    except Exception as exc:
        print(f"song_ranking: web search call failed: {exc}")
        return set()
    if not results:
        return set()

    artist_index: dict[str, int] = {}
    for a in all_artists:
        name = (a.get("name") or "").strip().lower()
        aid = a.get("id")
        if not name or aid is None:
            continue
        artist_index.setdefault(name, int(aid))

    matched = web_search.extract_artist_mentions(results, artist_index)
    if not matched:
        return set()

    # Embed each unique snippet once, then duplicate the vector across
    # any synthetic mentions that share that snippet.
    unique_texts: list[str] = []
    text_to_idx: dict[str, int] = {}
    flat: list[tuple[int, dict]] = []  # (artist_id, mention_dict)
    for aid, ments in matched.items():
        for m in ments:
            txt = m.get("_excerpt_text") or ""
            if not txt.strip():
                continue
            if txt not in text_to_idx:
                text_to_idx[txt] = len(unique_texts)
                unique_texts.append(txt)
            flat.append((aid, m))

    if not unique_texts:
        return set()

    try:
        vectors = embedder.embed(unique_texts, input_type="document")
    except Exception as exc:
        print(f"song_ranking: web snippet embed failed: {exc}")
        return set()

    if len(vectors) != len(unique_texts):
        print(
            f"song_ranking: web embed returned {len(vectors)} vectors for "
            f"{len(unique_texts)} snippets — skipping augmentation"
        )
        return set()

    # Register the virtual source so the existing scoring loop can resolve
    # trust_weight + display name without special-casing.
    source_info[web_search.WEB_SOURCE_ID] = {
        "trust_weight": web_search.WEB_TRUST_WEIGHT,
        "name": web_search.WEB_SOURCE_NAME,
    }

    boosted: set[int] = set()
    for aid, m in flat:
        idx = text_to_idx[m.get("_excerpt_text") or ""]
        injected = {
            "artist_id": aid,
            "source_id": web_search.WEB_SOURCE_ID,
            "embedding": vectors[idx],
            "published_at": m.get("published_at"),
            "sentiment": m.get("sentiment"),
            "excerpt": m.get("excerpt"),
        }
        mentions_by_artist[aid].append(injected)
        boosted.add(aid)

    print(
        f"song_ranking: web search augmented {len(boosted)} artists "
        f"with {len(flat)} synthetic mentions"
    )
    return boosted

