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
    _get_previously_recommended_artist_ids,
    _get_user_artist_weights,
    _get_user_feedback,
    _normalize_01,
    _percentile_rank,
)
from app.services.vector_rpc import (
    match_artists,
    max_mention_similarity_per_artist,
    track_similarity_for_artists,
)


_MOOD_WORDS = frozenset({
    "sad", "happy", "chill", "mellow", "upbeat", "energetic", "angry",
    "melancholy", "dreamy", "dark", "bright", "intense", "relaxing",
    "romantic", "nostalgic", "euphoric", "moody", "peaceful", "aggressive",
    "soothing", "hype", "calm", "somber", "joyful", "bittersweet",
    "anxious", "hopeful", "lonely", "party", "workout", "focus", "sleep",
    "study", "driving", "running", "cooking", "morning", "night", "rainy",
    "summer", "winter", "autumn", "spring", "beach", "road trip",
})

_CONTEXT_WORDS = frozenset({
    "new", "recent", "latest", "fresh", "upcoming", "underground",
    "obscure", "unknown", "local", "indie", "deep", "rare", "hidden",
})


def _chunked(items: list[int], size: int) -> list[list[int]]:
    return [items[i : i + size] for i in range(0, len(items), size)]


def _fetch_mentions_for_artist_ids(client: Client, artist_ids: list[int]) -> list[dict]:
    mentions: list[dict] = []
    for chunk in _chunked(artist_ids, 150):
        resp = (
            client.table("mentions")
            .select("artist_id,source_id,published_at,sentiment,excerpt,url")
            .in_("artist_id", chunk)
            .range(0, 9999)
            .execute()
        )
        mentions.extend(resp.data or [])
    return mentions


def _fetch_tracks_for_artist_ids(client: Client, artist_ids: list[int]) -> list[dict]:
    tracks: list[dict] = []
    for chunk in _chunked(artist_ids, 150):
        resp = (
            client.table("tracks")
            .select("id,name,artist_id,album_name,release_date,duration_ms,popularity,spotify_track_id,explicit,energy,danceability,valence,tempo,acousticness,instrumentalness,speechiness")
            .in_("artist_id", chunk)
            .range(0, 9999)
            .execute()
        )
        tracks.extend(resp.data or [])
    return tracks


def classify_prompt(prompt_text: str) -> str:
    """Classify a prompt as 'genre', 'mood', or 'semantic'.

    genre  = matches known genre tokens, use genre filter + embedding
    mood   = mood/activity words, rely on embedding similarity only
    semantic = mixed or unclear, use embedding only
    """
    words = set(prompt_text.strip().lower().replace("-", " ").split())
    mood_hits = words & _MOOD_WORDS
    context_hits = words & _CONTEXT_WORDS
    non_stop = words - {"the", "a", "an", "and", "or", "for", "my", "me", "some", "like", "with", "in", "on", "of"}

    if not non_stop:
        return "semantic"

    mood_ratio = len(mood_hits | context_hits) / len(non_stop)
    if mood_ratio >= 0.5:
        return "mood"
    return "genre"


def _assign_lane(
    track_pop: float,
    in_library: bool,
    is_library_artist: bool,
    editorial: float,
) -> str:
    if track_pop >= 0.72 and not in_library:
        return "radio_hit"
    if track_pop >= 0.48:
        return "popular"
    if track_pop <= 0.35 and not is_library_artist:
        return "deep_cut"
    if is_library_artist and track_pop > 0.42:
        return "popular"
    if editorial > 0.3:
        return "popular"
    return "deep_cut"


def recommend_songs(
    client: Client,
    user_id: str,
    taste_vector: list[float],
    prompt_vector: list[float] | None,
    weights: dict[str, float],
    exclude_library: bool,
    limit: int,
    prompt_text: str | None = None,
    excluded_track_ids: set[str] | None = None,
    excluded_artist_ids: set[int] | None = None,
    exploration_seed: int | None = None,
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

    # New user with no library: taste_vector is empty so cosine similarity
    # returns 0 for every artist, making affinity useless. Shift weight
    # entirely to editorial so the user still gets meaningful picks based on
    # press mentions and popularity rather than a blank slate.
    no_library = not taste_vector
    if no_library:
        print("song_ranking: empty taste vector — new user, shifting to editorial/context weights")
        if prompt_vector:
            weights = {"affinity": 0.0, "context": 0.7, "editorial": 0.3}
        else:
            weights = {"affinity": 0.0, "context": 0.0, "editorial": 1.0}
        # Use a zero vector so cosine calls don't crash; results will all be 0 affinity
        taste_vector = []

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

    excluded_artist_ids = excluded_artist_ids or set()

    # ── Candidate pool via pgvector RPC ──────────────────────────
    # Discovery cannot feel fresh if every click only considers the same top
    # few hundred taste-nearest artists. Pull a wider frontier, then sample
    # below the obvious head of the list later.
    POOL_SIZE = max(limit * 50, 1500)

    # Classify prompt to decide filtering strategy
    prompt_kind = classify_prompt(prompt_text) if prompt_text else None
    if prompt_kind:
        print(f"song_ranking: prompt '{prompt_text}' classified as '{prompt_kind}'")

    # Genre tokens: only apply genre filter when the prompt is actually
    # about a genre. Mood prompts ("sad night drive") and semantic prompts
    # rely on embedding similarity instead of genre substring matching.
    genre_tokens: list[str] | None = None
    if prompt_text and prompt_kind == "genre":
        _norm = prompt_text.strip().lower().replace("-", " ").strip()
        _toks = [w for w in _norm.split() if len(w) >= 2]
        if _toks:
            genre_tokens = _toks

    all_artists = match_artists(
        client,
        query_vector=taste_vector or None,
        match_count=POOL_SIZE,
        genre_tokens=genre_tokens,
    )
    genre_filtered = bool(genre_tokens) and len(all_artists) >= 5
    if genre_tokens and len(all_artists) < 5:
        print(
            f"song_ranking: genre filter '{prompt_text}' matched only "
            f"{len(all_artists)} artists — falling back to full catalog"
        )
        all_artists = match_artists(
            client,
            query_vector=taste_vector or None,
            match_count=POOL_SIZE,
        )
    elif genre_tokens:
        print(
            f"song_ranking: genre filter '{prompt_text}' matched "
            f"{len(all_artists)} artists"
        )

    # ── Fetch user's track data for familiarity detection ─────
    # Paginate to handle users with very large libraries (>9999 tracks).
    user_track_map: dict[int, dict] = {}
    _ut_offset = 0
    _ut_page = 1000
    while True:
        _ut_resp = (
            client.table("user_tracks")
            .select("track_id,play_count,last_played_at")
            .eq("user_id", user_id)
            .range(_ut_offset, _ut_offset + _ut_page - 1)
            .execute()
        )
        for row in (_ut_resp.data or []):
            if row.get("track_id"):
                user_track_map[row["track_id"]] = row
        if len(_ut_resp.data or []) < _ut_page:
            break
        _ut_offset += _ut_page

    # ── User audio feature profile ─────────────────────────────
    # Build a sound fingerprint from the user's most-played library tracks.
    # Weighted by play_count so frequently-heard tracks dominate the profile.
    _AUDIO_FEATS = ("energy", "danceability", "valence", "acousticness", "instrumentalness")
    user_audio_pref: dict[str, float] | None = None
    if user_track_map:
        # Sort by play_count descending so the most-listened tracks dominate
        # the weighted average — not just the first 300 rows the DB returned.
        _audio_ids = sorted(
            user_track_map.keys(),
            key=lambda tid: (user_track_map[tid].get("play_count") or 0),
            reverse=True,
        )[:300]
        try:
            _audio_resp = (
                client.table("tracks")
                .select("id,energy,danceability,valence,acousticness,instrumentalness")
                .in_("id", _audio_ids)
                .execute()
            )
            _feat_totals: dict[str, float] = defaultdict(float)
            _feat_weight = 0.0
            for _t in (_audio_resp.data or []):
                _tid = _t.get("id")
                _entry = user_track_map.get(_tid) or {}
                _play = max(float(_entry.get("play_count") or 1), 1.0)
                _has_feat = False
                for _feat in _AUDIO_FEATS:
                    _v = _t.get(_feat)
                    if _v is not None:
                        _feat_totals[_feat] += float(_v) * _play
                        _has_feat = True
                if _has_feat:
                    _feat_weight += _play
            if _feat_weight > 0 and len(_feat_totals) >= 2:
                user_audio_pref = {k: v / _feat_weight for k, v in _feat_totals.items()}
                print(f"song_ranking: audio profile built from {len(_audio_ids)} library tracks — "
                      f"energy={user_audio_pref.get('energy', 0):.2f} "
                      f"dance={user_audio_pref.get('danceability', 0):.2f} "
                      f"valence={user_audio_pref.get('valence', 0):.2f}")
        except Exception as _e:
            print(f"song_ranking: audio profile failed (non-fatal): {_e}")

    # ── Source/mention data for editorial + context signals ────
    candidate_ids = [int(a["id"]) for a in all_artists if a.get("id")]

    source_resp = (
        client.table("sources")
        .select("id,name,trust_weight,url")
        .range(0, 9999)
        .execute()
    )
    source_info: dict[int, dict] = {
        int(row["id"]): {
            "trust_weight": float(row.get("trust_weight") or 0.7),
            "name": row.get("name") or "",
            "url": row.get("url") or "",
        }
        for row in (source_resp.data or [])
        if row.get("id") is not None
    }

    if candidate_ids:
        # No embedding column — context similarity is computed in SQL via
        # max_mention_similarity_per_artist RPC below.
        mention_rows = _fetch_mentions_for_artist_ids(client, candidate_ids)
    else:
        mention_rows = []
    mentions_by_artist: dict[int, list[dict]] = defaultdict(list)
    for m in mention_rows:
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

    # Per-artist max(cosine(prompt|taste, mention.embedding)) computed in
    # SQL — replaces the in-process pass that needed every mention vector.
    # Computed whenever there's an effective query vector so the context
    # signal value is still populated when the weight has been redistributed
    # to 0 (mood-fallback path).
    if effective_prompt_vector and candidate_ids:
        context_by_artist = max_mention_similarity_per_artist(
            client, effective_prompt_vector, candidate_ids
        )
    else:
        context_by_artist = {}

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
    # Affinity comes from the RPC's `similarity` field — pgvector cosine
    # against taste_vector — so no embedding column is fetched here.
    non_recent_artist_count = sum(
        1
        for a in all_artists
        if a.get("id") is not None and int(a["id"]) not in excluded_artist_ids
    )
    hard_exclude_recent_artists = bool(excluded_artist_ids) and non_recent_artist_count >= max(limit * 3, 30)
    if hard_exclude_recent_artists:
        print(
            f"song_ranking: hard-excluding {len(excluded_artist_ids)} recent artists; "
            f"{non_recent_artist_count} alternatives available"
        )

    raw_affinities: list[tuple[dict, float]] = []
    for a in all_artists:
        if a.get("id") is None:
            continue
        aid = int(a["id"])
        if hard_exclude_recent_artists and aid in excluded_artist_ids:
            continue
        raw_affinities.append((a, float(a.get("similarity") or 0.0)))

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
    EXPLORATION_STRENGTH = 0.04 if has_explicit_prompt else 0.12
    rng = random.Random(exploration_seed) if exploration_seed is not None else random
    excluded_track_ids = excluded_track_ids or set()
    excluded_artist_ids = excluded_artist_ids or set()
    # Artist-level jitter: add a small random perturbation to each artist's
    # base score so that artists near the score boundary rotate in/out each
    # request. Without this, the same N artists always win Phase 1 and results
    # feel identical even when individual tracks are excluded.
    ARTIST_JITTER = 0.0 if has_explicit_prompt else 0.08

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
        editorial_components: list[float] = []
        best_mention: dict | None = None
        best_mention_score = -1.0

        for mention in artist_mentions:
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
                    "source_url": src["url"],
                    "article_url": mention.get("url") or "",
                    "excerpt": mention.get("excerpt"),
                    "published_at": pub_raw,
                }

        # Context = best mention-vs-query cosine, computed in SQL above.
        context_raw = context_by_artist.get(aid, 0.0)
        context = _normalize_01(context_raw) if context_by_artist else 0.0
        if editorial_components:
            _mean_e = sum(editorial_components) / len(editorial_components)
            _max_e = max(editorial_components)
            editorial = min(1.0, 0.55 * _max_e + 0.45 * _mean_e)
        else:
            editorial = 0.0

        base_score = (
            weights["affinity"] * affinity
            + weights["context"] * context
            + weights["editorial"] * editorial
        )

        if aid in previously_recommended:
            base_score *= 0.45

        if aid in excluded_artist_ids:
            base_score *= 0.15

        # Artist-level feedback adjustment
        artist_fb = feedback_scores.get(aid, 0)
        if artist_fb < 0:
            base_score *= max(0.15, 1.0 + (artist_fb * 0.25))
        elif artist_fb > 0:
            base_score *= min(1.4, 1.0 + (artist_fb * 0.08))

        # Per-request jitter: small random nudge so artists near the selection
        # boundary rotate across different sessions. Prompts stay deterministic.
        if ARTIST_JITTER:
            base_score += rng.uniform(-ARTIST_JITTER, ARTIST_JITTER)

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
    ranked_artist_ids = sorted(
        artist_scores.keys(),
        key=lambda a: artist_scores[a]["base_score"],
        reverse=True,
    )
    top_artist_ids = _select_artist_frontier(
        ranked_artist_ids,
        artist_scores,
        rng,
        limit,
        has_explicit_prompt=has_explicit_prompt,
    )

    if not top_artist_ids:
        return []

    # Track metadata only — no embedding column. Per-track similarity
    # against prompt and taste vectors is fetched via RPC below so we
    # never pull tracks.embedding (vector(1024)) over HTTPS.
    all_tracks = _fetch_tracks_for_artist_ids(client, top_artist_ids)


    # If the result pool is still shallow, widen artist frontier using
    # genre-neighbor artists related to the current top set. This helps
    # discover more songs without requiring a separate ingest pass.
    top_artist_ids_set = set(top_artist_ids)  # O(1) membership checks below
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
                if aid_int in top_artist_ids_set:
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
                extra_tracks = _fetch_tracks_for_artist_ids(client, extra_artist_ids)
                all_tracks.extend(extra_tracks)

                # Score expansion artists so Phase 3 can rank their tracks.
                # These artists were not in Phase 1 (they scored below the
                # top_artist_ids cutoff). Lookup similarity from the RPC pool
                # — they're already in `all_artists` because the RPC returned
                # them, just below the score cutoff.
                extra_artist_lookup = {
                    int(a["id"]): a
                    for a in all_artists
                    if a.get("id") is not None and int(a["id"]) in set(extra_artist_ids)
                }
                newly_added = 0
                for aid_int in extra_artist_ids:
                    if aid_int in artist_scores:
                        continue  # already scored
                    artist = extra_artist_lookup.get(aid_int)
                    if not artist:
                        continue
                    raw = float(artist.get("similarity") or 0.0)
                    affinity = _normalize_01(raw) * 0.7  # discounted vs Phase 1 artists
                    base_score = weights["affinity"] * affinity
                    if ARTIST_JITTER:
                        base_score += rng.uniform(-ARTIST_JITTER, ARTIST_JITTER)
                    artist_scores[aid_int] = {
                        "base_score": base_score,
                        "affinity": affinity,
                        "affinity_raw": raw,
                        "context": 0.0,
                        "editorial": 0.0,
                        "name": artist.get("name") or "Unknown",
                        "genres": list(artist.get("genres") or []),
                        "best_mention": None,
                        "mention_count": 0,
                        "spotify_artist_id": artist.get("spotify_artist_id"),
                    }
                    newly_added += 1

                top_artist_ids = top_artist_ids + [
                    a for a in extra_artist_ids if a in artist_scores
                ]
                print(f"song_ranking: genre expansion added {len(extra_artist_ids)} artists "
                      f"({newly_added} newly scored), {len(extra_tracks)} tracks")

    # Group tracks by artist, dropping excluded spotify_track_ids here so
    # Phase 3 never scores tracks that will be discarded anyway.
    tracks_by_artist: dict[int, list[dict]] = defaultdict(list)
    for t in all_tracks:
        aid = t.get("artist_id")
        if aid is None:
            continue
        if excluded_track_ids and (t.get("spotify_track_id") or "") in excluded_track_ids:
            continue
        tracks_by_artist[int(aid)].append(t)

    # ── Per-track cosine similarity via RPC (no embedding pulled) ─
    # Two SQL calls (one for prompt context, one for taste affinity) replace
    # what used to be a streaming pull of every tracks.embedding row.
    track_context_sim: dict[int, float] = {}
    track_taste_sim: dict[int, float] = {}
    if top_artist_ids:
        if effective_prompt_vector:
            track_context_sim = track_similarity_for_artists(
                client, effective_prompt_vector, top_artist_ids
            )
        if taste_vector:
            track_taste_sim = track_similarity_for_artists(
                client, taste_vector, top_artist_ids
            )

    # ── Phase 3: Score individual songs ──────────────────────────
    song_results: list[dict] = []
    seen_songs: set[str] = set()

    # Defined once outside the artist loop — closes over effective_prompt_vector,
    # rng, and now which are all fixed for the lifetime of this request.
    def _track_shortlist_score(t: dict) -> float:
        """Score a track for shortlist selection within an artist's catalog.

        Blends prompt/taste similarity, popularity, recency, and randomness.
        Randomness ensures variety across the novelty retry attempts (seed 0–4).
        Per-track similarity comes from the SQL RPC; no embedding crosses
        the wire.
        """
        pop = float(t.get("popularity") or 0) / 100.0
        recency = 0.0
        _rd = t.get("release_date")
        if _rd:
            try:
                _rd_dt = datetime.fromisoformat(str(_rd))
                _days_old = max((now.date() - _rd_dt.date()).days, 0)
                if _days_old < 365:
                    recency = 1.0 - _days_old / 365
            except (ValueError, AttributeError):
                pass
        tid = t.get("id")
        if effective_prompt_vector and tid is not None and tid in track_context_sim:
            ctx = _normalize_01(track_context_sim[tid])
            return 0.60 * ctx + 0.12 * pop + 0.10 * recency + 0.18 * rng.random()
        return 0.28 * pop + 0.12 * recency + 0.60 * rng.random()

    for aid in top_artist_ids:
        a_info = artist_scores.get(aid)
        if not a_info:
            continue

        tracks = tracks_by_artist.get(aid, [])
        if not tracks:
            continue

        tracks.sort(key=_track_shortlist_score, reverse=True)
        per_artist_cap = 5 if has_explicit_prompt else 4
        tracks = tracks[:per_artist_cap]

        for track in tracks:
            track_name = (track.get("name") or "").strip()
            spotify_tid = (track.get("spotify_track_id") or "").strip()
            # Prefer spotify_track_id for dedup (unique per recording).
            # Fall back to name+artist to catch untitled/missing-ID tracks.
            dedup_key = spotify_tid if spotify_tid else f"{track_name.lower()}|{a_info['name'].lower()}"
            if dedup_key in seen_songs:
                continue
            seen_songs.add(dedup_key)

            track_id = track.get("id")
            track_pop = float(track.get("popularity") or 50) / 100.0

            # ── Per-track context score ──────────────────────────
            # Prefer cosine(prompt, track.embedding) when the track has an
            # embedding. The cosine values come from the SQL RPC keyed by
            # track id — no embedding crosses the wire.
            track_context = a_info["context"]
            track_affinity = a_info["affinity"]
            used_track_embedding = False
            tid_lookup = track_id
            if tid_lookup is not None and (
                tid_lookup in track_context_sim or tid_lookup in track_taste_sim
            ):
                used_track_embedding = True
                if effective_prompt_vector and tid_lookup in track_context_sim:
                    track_context = _normalize_01(track_context_sim[tid_lookup])
                # Blend track-level taste similarity with artist affinity
                # so tracks whose description aligns with the user's taste
                # rank above generic ones. Skip the blend for new users
                # with no taste vector — artist-level affinity is already 0.
                if taste_vector and tid_lookup in track_taste_sim:
                    track_affinity_raw = _normalize_01(track_taste_sim[tid_lookup])
                    track_affinity = 0.7 * a_info["affinity"] + 0.3 * track_affinity_raw

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

            # Track-level boost: small popularity signal only — discovery is
            # the goal so we don't want hits to dominate just because they're hits.
            track_boost = 0.85 + (0.15 * track_pop)  # 0.85–1.0 range

            # New-release bonus: up to +15% for tracks released in the last
            # calendar year, decaying linearly to 0 at 365 days old.
            raw_release = track.get("release_date")
            if raw_release:
                try:
                    release_dt = datetime.fromisoformat(str(raw_release))
                    days_old = max((now.date() - release_dt.date()).days, 0)
                    if days_old < 365:
                        track_boost *= 1.0 + 0.15 * (1.0 - days_old / 365)
                except (ValueError, AttributeError):
                    pass

            # Familiarity: penalize songs the user has already heard,
            # but welcome NEW songs from familiar artists (deep cuts are
            # valuable discoveries even from artists you already know).
            in_library = track_id in user_track_map if track_id else False
            is_library_artist = aid in library_artist_ids
            if exclude_library and in_library:
                continue
            if in_library:
                # Time-decay: a track not played in 6+ months is a rediscovery,
                # not a repeat. Penalty relaxes from 0.45 (recent) → 0.80 (stale).
                _entry = user_track_map.get(track_id) or {}
                _staleness = 1.0
                _lp = _entry.get("last_played_at")
                if _lp:
                    try:
                        _lp_dt = datetime.fromisoformat(_lp.replace("Z", "+00:00"))
                        _days_since = max((now - _lp_dt).days, 0)
                        _staleness = max(0.0, 1.0 - _days_since / 180)
                    except (ValueError, AttributeError):
                        pass
                track_boost *= 0.45 + 0.35 * (1.0 - _staleness)
            elif is_library_artist:
                track_boost *= 0.90  # Very mild — new song from a known artist = great find

            # Obscurity bonus: reward genuinely unknown tracks that aren't
            # already in the user's library — defined after in_library is set.
            if track_pop < 0.40 and not in_library:
                track_boost *= 1.12

            # Audio feature alignment: prefer tracks that sound like the user's library.
            # This is the "does it sound right" signal — energy, danceability, mood, etc.
            if user_audio_pref:
                _diff_sq = sum(
                    (float(track.get(k) or 0.5) - user_audio_pref.get(k, 0.5)) ** 2
                    for k in ("energy", "danceability", "valence", "acousticness")
                )
                _audio_match = 1.0 - math.sqrt(_diff_sq / 4.0)
                track_boost *= 0.88 + 0.12 * _audio_match

            # Track-level feedback: stronger signal than artist-level because
            # "I don't like THIS song" is more precise than "I don't like this artist"
            spotify_track_id = track.get("spotify_track_id") or ""
            track_fb = track_feedback.get(spotify_track_id, 0)
            if track_fb < 0:
                track_boost *= 0.15  # Very strong penalty — user explicitly disliked this track
            elif track_fb > 0:
                track_boost *= 1.15  # Modest boost

            # Exploration
            exploration = rng.uniform(-EXPLORATION_STRENGTH, EXPLORATION_STRENGTH)

            final_score = track_base * track_boost + exploration

            # ── Lane + novelty/familiarity assignment ──────────────
            lane = _assign_lane(track_pop, in_library, is_library_artist, a_info["editorial"])

            familiarity_score = 0.0
            if in_library:
                familiarity_score = 1.0
            elif is_library_artist:
                familiarity_score = 0.6
            elif aid in previously_recommended:
                familiarity_score = 0.3

            novelty_score = 1.0 - familiarity_score

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
            if raw_release:
                try:
                    release_dt = datetime.fromisoformat(str(raw_release))
                    days_old = max((now.date() - release_dt.date()).days, 0)
                    if days_old < 365:
                        reasons.append("New release")
                except (ValueError, AttributeError):
                    pass
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
                "release_date": track.get("release_date"),
                "duration_ms": track.get("duration_ms") or 0,
                "explicit": track.get("explicit") or False,
                "spotify_track_id": spotify_track_id,
                "score": round(max(0.0, final_score), 4),
                "lane": lane,
                "novelty_score": round(novelty_score, 4),
                "familiarity_score": round(familiarity_score, 4),
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

    # ── Lane-aware diversity re-ranking ─────────────────────────
    diverse = _lane_diversity_rerank(song_results, max(limit, 0))

    return diverse


# Lane quotas as fractions of the total result set.
# deep_cut gets the largest share — the whole point is discovery.
_LANE_QUOTAS = {
    "deep_cut": 0.45,
    "popular": 0.35,
    "radio_hit": 0.20,
}


def _select_artist_frontier(
    ranked_artist_ids: list[int],
    artist_scores: dict[int, dict],
    rng: random.Random,
    limit: int,
    *,
    has_explicit_prompt: bool,
) -> list[int]:
    """Choose the artist frontier to fetch tracks for.

    Keep the strongest matches, but intentionally include a rotating slice from
    the long tail of viable matches. Without this, novelty filtering only
    reshuffles the same high-affinity artists and Discover feels static.
    """
    if not ranked_artist_ids:
        return []

    frontier_size = min(len(ranked_artist_ids), max(limit * 28, 700))
    head_size = min(len(ranked_artist_ids), max(limit * 4, 100))
    head = ranked_artist_ids[:head_size]

    remaining_slots = max(0, frontier_size - len(head))
    if remaining_slots == 0:
        return head

    # Prompted searches should stay more on-intent, but still rotate below the
    # obvious top matches. Unprompted discovery can range wider.
    candidate_multiplier = 3 if has_explicit_prompt else 6
    frontier_pool = ranked_artist_ids[head_size : head_size + remaining_slots * candidate_multiplier]
    if not frontier_pool:
        return head

    weighted_pool: list[int] = []
    for idx, aid in enumerate(frontier_pool):
        score = max(float(artist_scores.get(aid, {}).get("base_score") or 0.0), 0.0)
        # Higher ranked artists get more tickets, but everyone in the pool has
        # a chance. This creates meaningful session-to-session movement without
        # ignoring taste.
        tickets = max(1, int(score * 6) + max(0, 4 - idx // max(limit, 1)))
        weighted_pool.extend([aid] * tickets)

    sampled: list[int] = []
    seen = set(head)
    while weighted_pool and len(sampled) < remaining_slots:
        aid = rng.choice(weighted_pool)
        weighted_pool = [candidate for candidate in weighted_pool if candidate != aid]
        if aid in seen:
            continue
        seen.add(aid)
        sampled.append(aid)

    if len(sampled) < remaining_slots:
        for aid in frontier_pool:
            if aid in seen:
                continue
            sampled.append(aid)
            seen.add(aid)
            if len(sampled) >= remaining_slots:
                break

    sampled.sort(
        key=lambda aid: artist_scores.get(aid, {}).get("base_score", 0.0),
        reverse=True,
    )
    return head + sampled


def _lane_diversity_rerank(scored: list[dict], limit: int) -> list[dict]:
    """Re-rank songs for genre + artist + lane diversity.

    Enforces lane quotas so the result always has a healthy mix of
    deep cuts, popular picks, and familiar comfort picks.
    """
    if not scored or limit <= 0:
        return []

    pool = scored if len(scored) <= limit * 15 else scored[: limit * 15]

    # Pre-sort each lane's candidates by score
    lane_pools: dict[str, list[dict]] = defaultdict(list)
    for s in pool:
        lane_pools[s.get("lane", "deep_cut")].append(s)

    lane_targets = {
        lane: max(1, int(limit * frac))
        for lane, frac in _LANE_QUOTAS.items()
    }
    # Distribute any rounding remainder to deep_cut
    assigned = sum(lane_targets.values())
    if assigned < limit:
        lane_targets["deep_cut"] += limit - assigned

    selected: list[dict] = []
    lane_counts: Counter[str] = Counter()
    genre_counts: Counter[str] = Counter()
    artist_counts: Counter[str] = Counter()
    used: set[str] = set()

    MAX_GENRE_FRACTION = 0.3
    MAX_ARTIST_SONGS = 1

    # Round-robin across lanes in priority order
    lane_order = ["deep_cut", "popular", "radio_hit"]
    lane_cursors: dict[str, int] = {l: 0 for l in lane_order}

    rounds_without_progress = 0
    while len(selected) < limit and rounds_without_progress < 3:
        progress_this_round = False
        for lane in lane_order:
            if len(selected) >= limit:
                break
            if lane_counts[lane] >= lane_targets.get(lane, 0):
                continue

            candidates = lane_pools.get(lane, [])
            cursor = lane_cursors[lane]
            picked = False

            while cursor < len(candidates):
                candidate = candidates[cursor]
                cursor += 1

                key = f"{candidate['track_name']}|{candidate['artist_name']}".lower()
                if key in used:
                    continue

                artist = candidate["artist_name"].lower()
                if artist_counts.get(artist, 0) >= MAX_ARTIST_SONGS:
                    continue

                genres = [g.lower() for g in (candidate.get("genres") or [])] or ["__none__"]
                max_genre_share = max(
                    genre_counts.get(g, 0.0) / max(len(selected), 1) for g in genres
                )
                if max_genre_share >= MAX_GENRE_FRACTION and len(selected) > 5:
                    continue

                selected.append(candidate)
                used.add(key)
                lane_counts[lane] += 1
                artist_counts[artist] += 1
                for g in genres:
                    genre_counts[g] += 1.0 / len(genres)
                picked = True
                progress_this_round = True
                break

            lane_cursors[lane] = cursor

            if not picked:
                # This lane is exhausted — allow overflow into other lanes
                lane_targets[lane] = lane_counts[lane]

        if not progress_this_round:
            rounds_without_progress += 1
        else:
            rounds_without_progress = 0

    distinct_artist_count = len({
        (str(candidate.get("artist_id") or "") or candidate["artist_name"]).lower()
        for candidate in pool
    })
    unique_artist_target = min(limit, distinct_artist_count)

    def top_up(max_artist_songs: int) -> None:
        """Fill open slots while preserving artist spread as long as possible."""
        nonlocal selected
        for candidate in pool:
            if len(selected) >= limit:
                break
            key = f"{candidate['track_name']}|{candidate['artist_name']}".lower()
            if key in used:
                continue
            artist = (str(candidate.get("artist_id") or "") or candidate["artist_name"]).lower()
            # Do not add a second song by any artist until every possible slot
            # that can be filled by a unique artist has been filled. This keeps
            # artists from appearing across multiple UI lanes when the catalog
            # has enough breadth.
            if len(selected) < unique_artist_target and artist_counts.get(artist, 0) >= 1:
                continue
            if artist_counts.get(artist, 0) >= max_artist_songs:
                continue
            selected.append(candidate)
            used.add(key)
            lane_counts[candidate.get("lane", "deep_cut")] += 1
            artist_counts[artist] += 1

    # Top-up pass: first preserve one artist per result; only then relax for
    # genuinely sparse catalogs where duplicates are better than empty slots.
    if len(selected) < limit:
        top_up(1)
    if len(selected) < limit:
        top_up(2)

    print(f"song_ranking: lane distribution — {dict(lane_counts)}")
    return selected


_song_diversity_rerank = _lane_diversity_rerank
