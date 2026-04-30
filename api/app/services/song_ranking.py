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

from app.services.mood import detect_mood, mood_fit
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


def _adjust_weights_for_prompt(
    weights: dict[str, float], has_explicit_prompt: bool
) -> dict[str, float]:
    """Tilt the affinity/context/editorial blend when a prompt is set.

    With a prompt, the user has named what they want — context should
    dominate. We blend the caller's weights 60/40 toward a prompt-tilted
    profile (0.30 affinity / 0.55 context / 0.15 editorial) rather than
    overriding outright, so a caller that explicitly wants high
    affinity (e.g. "more like my library") still gets some of it.

    Without a prompt, return weights unchanged.
    """
    if not has_explicit_prompt:
        return weights
    target = {"affinity": 0.30, "context": 0.55, "editorial": 0.15}
    blended = {
        k: 0.4 * weights.get(k, 0.0) + 0.6 * target[k]
        for k in target
    }
    total = sum(blended.values()) or 1.0
    return {k: v / total for k, v in blended.items()}


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

    now = datetime.now(timezone.utc)
    recent_window_days = 45

    effective_prompt_vector = prompt_vector if prompt_vector else taste_vector
    has_explicit_prompt = prompt_vector is not None

    # Detect a mood category from the prompt ("chill", "energetic",
    # etc.). When present, we blend a tag-overlap mood-fit score into
    # each track's context — a tag-based stand-in for the audio
    # features Spotify deprecated for new apps.
    active_mood = detect_mood(prompt_text) if has_explicit_prompt else None
    if active_mood:
        print(f"song_ranking: active mood = {active_mood!r}")

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

    # Lower exploration noise: ±2% instead of ±6%. The percentile-rank
    # step + diversity re-rank already produce variety; adding 6% noise
    # on top compresses the top of the distribution and lets weaker
    # picks leapfrog clearly-better ones too often.
    EXPLORATION_STRENGTH = 0.02

    # When the user supplies an explicit prompt, shift the weight blend
    # toward context: their prompt is the strongest expression of
    # intent. Without a prompt we fall back to the caller's defaults
    # (the API normalizes affinity/context/editorial inputs to sum to 1).
    weights = _adjust_weights_for_prompt(weights, has_explicit_prompt)

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
    # Wider fan-out (limit*12) gives the diversity re-ranker more
    # material to work with; the cap is still bounded so the per-track
    # scoring loop stays cheap.
    FAN_OUT = max(limit * 12, 50)

    # ── BM25 cross-artist expansion ──────────────────────────────
    # Run an unrestricted BM25 lookup first so artists the vector
    # missed but who have textually-strong matching tracks still get
    # considered. Their matches are also stored in bm25_by_track and
    # used for the per-track context blend below.
    bm25_by_track: dict[int, float] = {}
    bm25_max = 0.0
    bm25_artist_ids: set[int] = set()
    if has_explicit_prompt and prompt_text and prompt_text.strip():
        try:
            rpc_resp = client.rpc(
                "search_tracks_bm25",
                {
                    "q": prompt_text.strip(),
                    "artist_ids": None,
                    "max_results": max(FAN_OUT * 4, 200),
                },
            ).execute()
            for row in (rpc_resp.data or []):
                tid = row.get("track_id")
                aid_row = row.get("artist_id")
                rank = row.get("rank")
                if tid is None or rank is None:
                    continue
                rank_f = float(rank)
                if rank_f <= 0:
                    continue
                bm25_by_track[int(tid)] = rank_f
                if aid_row is not None:
                    bm25_artist_ids.add(int(aid_row))
                if rank_f > bm25_max:
                    bm25_max = rank_f
            if bm25_by_track:
                print(
                    f"song_ranking: bm25 matched {len(bm25_by_track)} tracks "
                    f"(max rank {bm25_max:.4f})"
                )
        except Exception as exc:
            # Older deployments may not have migration 013 yet. Don't
            # fail the request — just skip the BM25 signal.
            print(f"song_ranking: bm25 RPC unavailable ({type(exc).__name__}: {exc})")

    def _bm25_norm(track_id: int | None) -> float:
        if not track_id or bm25_max <= 0:
            return 0.0
        return bm25_by_track.get(int(track_id), 0.0) / bm25_max

    # Build the candidate pool. Start with the top FAN_OUT artists by
    # base_score, then union in artists pulled in by BM25 — these are
    # artists whose tracks textually matched the prompt even though
    # the artist's vector didn't make the cut.
    top_artist_ids = sorted(
        artist_scores.keys(),
        key=lambda a: artist_scores[a]["base_score"],
        reverse=True,
    )[:FAN_OUT]
    if bm25_artist_ids:
        # Cap how many BM25-only artists we admit so a noisy text
        # match doesn't crowd out the taste-driven pool.
        bm25_only = [
            aid for aid in bm25_artist_ids
            if aid in artist_scores and aid not in top_artist_ids
        ]
        if bm25_only:
            keep = bm25_only[: max(FAN_OUT // 2, 20)]
            top_artist_ids = list(top_artist_ids) + keep
            print(
                f"song_ranking: pool widened by bm25 — "
                f"+{len(keep)} artists (total {len(top_artist_ids)})"
            )

    if not top_artist_ids:
        return []

    # Get tracks from DB for these artists. We pull the track embedding
    # so the context signal can be computed track-by-track instead of
    # inheriting the artist-level mention match.
    tracks_resp = (
        client.table("tracks")
        .select("id,name,artist_id,album_name,duration_ms,popularity,spotify_track_id,explicit,energy,danceability,valence,tempo,acousticness,instrumentalness,speechiness,embedding,tags")
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

        # Choose the top 2 candidate tracks per artist. When we have
        # both a prompt vector and track embeddings, rank by a blend of
        # prompt-fit and popularity so a vibe search ("rainy night",
        # "summer driving") doesn't always surface the artist's biggest
        # hit. BM25 boosts tracks whose title/tags literally match the
        # query so a search for "Bohemian Rhapsody" doesn't lose to a
        # semantically-similar but textually-unrelated track.
        def _track_shortlist_score(t: dict) -> float:
            pop = float(t.get("popularity") or 0) / 100.0
            tv = _parse_vector(t.get("embedding"))
            bm25 = _bm25_norm(t.get("id"))
            if effective_prompt_vector and tv:
                ctx = _normalize_01(
                    _cosine_similarity(effective_prompt_vector, tv)
                )
                # Hybrid: 55% vector + 25% bm25 + 20% popularity
                return 0.55 * ctx + 0.25 * bm25 + 0.20 * pop
            # No vector? Lean on bm25 + popularity instead of pop alone.
            return 0.6 * bm25 + 0.4 * pop if bm25 else pop

        tracks.sort(key=_track_shortlist_score, reverse=True)
        tracks = tracks[:2]

        for track in tracks:
            track_name = (track.get("name") or "").strip()
            dedup_key = f"{track_name.lower()}|{a_info['name'].lower()}"
            if dedup_key in seen_songs:
                continue
            seen_songs.add(dedup_key)

            track_id = track.get("id")
            track_pop = float(track.get("popularity") or 50) / 100.0
            track_bm25 = _bm25_norm(track_id)
            track_mood_fit = mood_fit(active_mood, track.get("tags"))

            # ── Per-track context score ──────────────────────────
            # Prefer cosine(prompt, track.embedding). This is the core
            # quality lift: tracks within the same artist now score
            # differently for prompts like "summer driving" or "sad
            # piano", instead of all inheriting the artist's match.
            track_vec = _parse_vector(track.get("embedding"))
            vector_context: float | None = None
            track_affinity = a_info["affinity"]
            used_track_embedding = False
            if track_vec:
                if effective_prompt_vector:
                    vector_context = _normalize_01(
                        _cosine_similarity(effective_prompt_vector, track_vec)
                    )
                # Blend track-level taste similarity with the artist
                # affinity so that, within an artist's catalog, tracks
                # whose description aligns with the user's taste vector
                # rank above generic ones.
                track_affinity_raw = _normalize_01(
                    _cosine_similarity(taste_vector, track_vec)
                )
                track_affinity = 0.7 * a_info["affinity"] + 0.3 * track_affinity_raw
                used_track_embedding = True

            # Hybrid context: blend vector cosine with BM25. Vector
            # captures "feel"; BM25 captures literal phrase fit. When
            # both are available we lean vector-heavy (0.65) so vibe
            # prompts still work, but a strong BM25 hit alone can lift
            # a track that the vector missed.
            if vector_context is None:
                if track_bm25 > 0:
                    track_context = 0.65 * a_info["context"] + 0.35 * track_bm25
                else:
                    track_context = a_info["context"]
            elif track_bm25 > 0:
                track_context = 0.65 * vector_context + 0.35 * track_bm25
            else:
                track_context = vector_context

            # Mood-fit boost (tag overlap). Additive and capped at +0.15
            # so it nudges mood-aligned tracks up without dominating.
            if track_mood_fit > 0:
                track_context = min(1.0, track_context + 0.15 * track_mood_fit)

            # Recompute the base score per track using the (possibly)
            # track-specific affinity and context. Editorial stays at
            # the artist level — mentions are about the artist, not
            # any one song.
            track_base = (
                weights["affinity"] * track_affinity
                + weights["context"] * track_context
                + weights["editorial"] * a_info["editorial"]
            )
            if aid in previously_recommended:
                track_base *= 0.65

            # Track-level boost: popularity + familiarity adjustments
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

            final_score = track_base * track_boost + exploration

            # Build reasons
            reasons = []
            if track_affinity > 0.55:
                reasons.append("Matches your taste")
            if track_context > 0.55:
                reasons.append("Matches your search" if has_explicit_prompt else "Fits your vibe")
            if a_info["editorial"] > 0.45:
                src_name = (
                    a_info["best_mention"]["source"]
                    if a_info["best_mention"] and a_info["best_mention"].get("source")
                    else ""
                )
                reasons.append(f"Featured in {src_name}" if src_name else "In the press")
            if track_pop > 0.7:
                reasons.append("Popular track")
            if has_explicit_prompt and track_bm25 >= 0.5:
                # Strong literal phrase match — title, album, or a tag
                # contained the user's query terms.
                reasons.append("Title/tag match")
            if active_mood and track_mood_fit >= 0.4:
                reasons.append(f"Mood: {active_mood}")
            track_tags = [t for t in (track.get("tags") or []) if t]
            if track_tags and has_explicit_prompt and track_context > 0.55:
                # Only surface tags as a reason when they likely drove
                # the match — a strong context score with a prompt.
                preview = ", ".join(track_tags[:3])
                reasons.append(f"Tagged: {preview}")
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
                    "affinity": round(track_affinity, 4),
                    "context": round(track_context, 4),
                    "editorial": round(a_info["editorial"], 4),
                    "track_popularity": round(track_pop, 4),
                    "track_embedding": used_track_embedding,
                    "bm25": round(track_bm25, 4),
                    "mood": active_mood,
                    "mood_fit": round(track_mood_fit, 4),
                },
                "genres": a_info["genres"],
                "tags": track_tags,
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

