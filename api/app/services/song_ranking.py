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
    _get_user_feedback,
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
    feedback_scores = _get_user_feedback(client, user_id)

    # Build a per-spotify-track-id feedback map for track-level signals
    try:
        track_fb_resp = (
            client.table("user_feedback")
            .select("spotify_track_id,feedback")
            .eq("user_id", user_id)
            .range(0, 9999)
            .execute()
        )
        track_feedback: dict[str, int] = {
            row["spotify_track_id"]: int(row["feedback"])
            for row in (track_fb_resp.data or [])
            if row.get("spotify_track_id") and row.get("feedback") is not None
        }
    except Exception:
        track_feedback = {}

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

    # When there's no explicit prompt, zero out the context weight and
    # redistribute it to affinity. The old behavior used the taste vector
    # as a proxy for context, but this made the context signal identical
    # to affinity — every artist scored ~0.75 context for every user,
    # drowning out the actual per-user taste differences.
    if not has_explicit_prompt:
        redistributed = weights.get("context", 0.0)
        weights = {
            "affinity": weights["affinity"] + redistributed * 0.8,
            "context": 0.0,  # No prompt = no context signal
            "editorial": weights["editorial"] + redistributed * 0.2,
        }

    # ── Build per-user genre preference weights ───────────────
    # The user's library artists have genres. Weight each genre by
    # how much the user listens to it. This lets genre overlap between
    # a candidate and the user's taste break ties that embedding
    # similarity alone can't distinguish.
    user_genre_weights: dict[str, float] = {}
    if library_artist_ids:
        lib_artists_resp = (
            client.table("artists")
            .select("id,genres")
            .in_("id", list(library_artist_ids)[:500])
            .not_.is_("genres", "null")
            .range(0, 9999)
            .execute()
        )
        genre_totals: dict[str, float] = defaultdict(float)
        for a in (lib_artists_resp.data or []):
            w = artist_weights.get(int(a["id"]), 1.0)
            for g in (a.get("genres") or []):
                genre_totals[g.lower()] += w
        if genre_totals:
            max_w = max(genre_totals.values())
            user_genre_weights = {
                g: v / max_w for g, v in genre_totals.items()
            }

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

    # ── Detect "universal attractors" ──────────────────────────
    # Some artists have embeddings near the centroid of the entire
    # vector space, so they score high affinity for EVERY user. These
    # aren't truly personalized matches. Penalize artists whose raw
    # cosine similarity is in the top percentile across ALL users by
    # checking if they're above the 90th percentile. This is a proxy:
    # truly personalized matches should have some users where they
    # rank low and some where they rank high. Artists that rank high
    # for everyone are probably just centrally-located in embedding
    # space. We apply a moderate penalty to push them down.
    if raw_vals:
        raw_sorted = sorted(raw_vals)
        p90_threshold = raw_sorted[int(len(raw_sorted) * 0.92)] if len(raw_sorted) > 10 else 1.0
    else:
        p90_threshold = 1.0

    # Use stronger exploration for non-prompted queries so browsing feels
    # fresh and different between users.  With a prompt the user has a
    # specific intent and results should be more deterministic.
    EXPLORATION_STRENGTH = 0.04 if has_explicit_prompt else 0.10

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

        # ── Genre affinity boost ────────────────────────────────
        # Embedding similarity alone can miss important user-specific
        # genre preferences. If the user's library is heavily weighted
        # towards specific genres, boost artists in those genres.
        artist_genres = set((g.lower() for g in (artist.get("genres") or [])))
        if user_genre_weights and artist_genres:
            genre_boost = sum(
                user_genre_weights.get(g, 0.0)
                for g in artist_genres
            ) / max(len(artist_genres), 1)
            # Scale: 0 for no overlap, up to ~0.15 boost for strong match
            affinity = min(1.0, affinity + genre_boost * 0.15)

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

        # Artist-level feedback adjustment
        artist_fb = feedback_scores.get(aid, 0)
        if artist_fb < 0:
            base_score *= max(0.15, 1.0 + (artist_fb * 0.25))
        elif artist_fb > 0:
            base_score *= min(1.4, 1.0 + (artist_fb * 0.08))

        artist_scores[aid] = {
            "base_score": base_score,
            "affinity": affinity,
            "affinity_raw": affinity_raw,
            "context": context,
            "editorial": editorial,
            "name": artist.get("name") or "Unknown",
            "genres": list(artist.get("genres") or []),
            "best_mention": best_mention,
            "mention_count": len(artist_mentions),
            "spotify_artist_id": artist.get("spotify_artist_id"),
        }

    # ── Phase 2: Fetch tracks for top artists ────────────────────
    # Expand all scored artists — with a small catalog (500ish artists with
    # tracks) limiting to top-N misses user-specific deep cuts. We fetch
    # tracks for ALL scored artists and let the per-track scoring + diversity
    # reranking do the filtering.
    top_artist_ids = sorted(
        artist_scores.keys(),
        key=lambda a: artist_scores[a]["base_score"],
        reverse=True,
    )[: max(limit * 20, 500)]  # Wider frontier than before to pull from more artists

    if not top_artist_ids:
        return []

    # Get tracks from DB for these artists. We pull the track embedding
    # so the context signal can be computed track-by-track instead of
    # inheriting the artist-level mention match.
    tracks_resp = (
        client.table("tracks")
        .select("id,name,artist_id,album_name,duration_ms,popularity,spotify_track_id,explicit,energy,danceability,valence,tempo,acousticness,instrumentalness,speechiness,embedding")
        .in_("artist_id", top_artist_ids)
        .range(0, 9999)
        .execute()
    )
    all_tracks = tracks_resp.data or []


    # If the result pool is still shallow, widen artist frontier using
    # genre-neighbor artists related to the current top set. This helps
    # discover more songs without requiring a separate ingest pass.
    if len(all_tracks) < max(limit * 6, 30):
        seed_genres = {
            g.lower()
            for aid in top_artist_ids[: max(limit, 10)]
            for g in (artist_scores.get(aid, {}).get("genres") or [])
            if g
        }
        if seed_genres:
            extra_artist_ids: list[int] = []
            for artist in all_artists:
                aid = artist.get("id")
                if aid is None:
                    continue
                aid_int = int(aid)
                if aid_int in top_artist_ids:
                    continue
                genres = [g.lower() for g in (artist.get("genres") or [])]
                if not genres:
                    continue
                overlap = sum(1 for g in genres if g in seed_genres)
                if overlap > 0:
                    extra_artist_ids.append(aid_int)
                if len(extra_artist_ids) >= limit * 12:
                    break

            if extra_artist_ids:
                extra_tracks_resp = (
                    client.table("tracks")
                    .select("id,name,artist_id,album_name,duration_ms,popularity,spotify_track_id,explicit,energy,danceability,valence,tempo,acousticness,instrumentalness,speechiness,embedding")
                    .in_("artist_id", extra_artist_ids)
                    .range(0, 9999)
                    .execute()
                )
                extra_tracks = extra_tracks_resp.data or []
                all_tracks.extend(extra_tracks)

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

        # Choose candidate tracks per artist. When we have
        # both a prompt vector and track embeddings, rank by a blend of
        # prompt-fit and popularity so a vibe search ("rainy night",
        # "summer driving") doesn't always surface the artist's biggest
        # hit. Without that, fall back to popularity alone.
        def _track_shortlist_score(t: dict) -> float:
            pop = float(t.get("popularity") or 0) / 100.0
            tv = _parse_vector(t.get("embedding"))
            if effective_prompt_vector and tv:
                ctx = _normalize_01(
                    _cosine_similarity(effective_prompt_vector, tv)
                )
                return 0.7 * ctx + 0.3 * pop
            return pop

        tracks.sort(key=_track_shortlist_score, reverse=True)
        per_artist_cap = 3 if has_explicit_prompt else 2
        tracks = tracks[:per_artist_cap]

        for track in tracks:
            track_name = (track.get("name") or "").strip()
            dedup_key = f"{track_name.lower()}|{a_info['name'].lower()}"
            if dedup_key in seen_songs:
                continue
            seen_songs.add(dedup_key)

            track_id = track.get("id")
            track_pop = float(track.get("popularity") or 50) / 100.0

            # ── Per-track context score ──────────────────────────
            # Prefer cosine(prompt, track.embedding). This is the core
            # quality lift: tracks within the same artist now score
            # differently for prompts like "summer driving" or "sad
            # piano", instead of all inheriting the artist's match.
            track_vec = _parse_vector(track.get("embedding"))
            track_context = a_info["context"]
            track_affinity = a_info["affinity"]
            used_track_embedding = False
            if track_vec:
                if effective_prompt_vector:
                    track_context = _normalize_01(
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

            # Recompute the base score per track using the (possibly)
            # track-specific affinity and context. Editorial stays at
            # the artist level — mentions are about the artist, not
            # any one song.
            track_base = (
                weights["affinity"] * track_affinity
                + weights["context"] * track_context
                + weights["editorial"] * a_info["editorial"]
            )

            # Universal attractor penalty: if this artist has high raw
            # cosine with ALL taste vectors (above p90), it's probably
            # central in embedding space, not a genuine personal match.
            if a_info["affinity_raw"] > p90_threshold and not has_explicit_prompt:
                track_base *= 0.75  # 25% penalty for universally-popular embeddings

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

            # Track-level feedback: stronger signal than artist-level because
            # "I don't like THIS song" is more precise than "I don't like this artist"
            track_spotify_id = track.get("spotify_track_id") or ""
            track_fb = track_feedback.get(track_spotify_id, 0)
            if track_fb < 0:
                track_boost *= 0.15  # Very strong penalty — user explicitly disliked this track
            elif track_fb > 0:
                track_boost *= 1.15  # Modest boost

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

