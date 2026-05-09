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
    _get_user_library_artist_ids,
    _get_previously_recommended_artist_ids,
    _get_user_artist_weights,
    _get_user_feedback,
    _normalize_01,
    _parse_vector,
    _percentile_rank,
)
from app.services.vector_rpc import (
    match_artists,
    max_mention_similarity_per_artist,
    track_similarity_for_artists,
)

DISCOVERY_LANES = ("deep_cuts", "popular", "radio_hits")

_GENRE_PHRASES = {
    "alternative rock",
    "hip hop",
    "hip-hop",
    "r&b",
    "indie rock",
    "indie pop",
    "electronic",
    "dance",
    "house",
    "techno",
    "ambient",
    "jazz",
    "metal",
    "punk",
    "folk",
    "country",
    "americana",
    "soul",
    "funk",
    "classical",
    "reggae",
    "latin",
    "pop",
    "rock",
    "rap",
}

_GENRE_TOKEN_STOPWORDS = {
    "new",
    "old",
    "sad",
    "happy",
    "chill",
    "night",
    "drive",
    "work",
    "study",
    "songs",
    "music",
    "vibes",
    "like",
}


def _genre_tokens_for_prompt(prompt_text: str | None) -> list[str] | None:
    if not prompt_text:
        return None
    normalized = prompt_text.strip().lower().replace("-", " ")
    normalized = " ".join(normalized.split())
    if not normalized:
        return None

    hits: list[str] = []
    for phrase in sorted(_GENRE_PHRASES, key=len, reverse=True):
        phrase_norm = phrase.replace("-", " ")
        if phrase_norm in normalized:
            hits.extend([tok for tok in phrase_norm.split() if tok not in _GENRE_TOKEN_STOPWORDS])

    if not hits:
        return None

    deduped: list[str] = []
    seen: set[str] = set()
    for token in hits:
        if token and token not in seen:
            seen.add(token)
            deduped.append(token)
    return deduped or None


def _release_age_days(raw_release: object, now: datetime) -> int | None:
    if not raw_release:
        return None
    try:
        release_dt = datetime.fromisoformat(str(raw_release))
    except (ValueError, AttributeError):
        return None
    return max((now.date() - release_dt.date()).days, 0)


def _lane_for_track(
    track_pop: float,
    genres: list[str],
    reasons: list[str],
    editorial: float,
    release_age_days: int | None,
) -> str:
    reason_text = " ".join(reasons).lower()
    genre_text = " ".join(genres).lower()
    has_deep_signal = (
        "deep cut" in reason_text
        or "obscure" in reason_text
        or "indie" in genre_text
        or "underground" in genre_text
        or (editorial >= 0.45 and track_pop < 0.62)
    )
    is_newish = release_age_days is not None and release_age_days <= 540
    if has_deep_signal or track_pop < 0.46:
        return "deep_cuts"
    if track_pop >= 0.78 and not is_newish:
        return "radio_hits"
    return "popular"


def _novelty_score(
    track_pop: float,
    editorial: float,
    in_library: bool,
    is_library_artist: bool,
    release_age_days: int | None,
) -> float:
    release_bonus = 0.0
    if release_age_days is not None and release_age_days < 365:
        release_bonus = 1.0 - release_age_days / 365
    score = (
        0.45 * (1.0 - track_pop)
        + 0.22 * editorial
        + 0.18 * (0.0 if is_library_artist else 1.0)
        + 0.15 * release_bonus
    )
    if in_library:
        score *= 0.35
    return max(0.0, min(1.0, score))


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
    library_artist_ids = _get_user_library_artist_ids(client, user_id)
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

    # ── Candidate pool via pgvector RPC ──────────────────────────
    # Migration 017 pushes cosine similarity into Postgres so we don't
    # stream every artists.embedding vector(1024) over HTTPS — which used
    # to time out the Render→Supabase connection on Discover requests.
    # The RPC returns metadata + similarity; embeddings stay in Postgres.
    POOL_SIZE = max(limit * 20, 500)

    # Only use hard genre filtering when the prompt actually names a genre.
    # Mood prompts like "sad night drive" should stay semantic; treating every
    # token as a genre filter made searches feel oddly literal.
    genre_tokens = _genre_tokens_for_prompt(prompt_text)

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
        mention_resp = (
            client.table("mentions")
            .select("artist_id,source_id,published_at,sentiment,excerpt,url")
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
    raw_affinities: list[tuple[dict, float]] = [
        (a, float(a.get("similarity") or 0.0))
        for a in all_artists
        if a.get("id") is not None
    ]

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
            base_score *= 0.65

        if aid in excluded_artist_ids:
            base_score *= 0.58

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
    top_artist_ids = sorted(
        artist_scores.keys(),
        key=lambda a: artist_scores[a]["base_score"],
        reverse=True,
    )[: max(limit * 20, 500)]  # Wider frontier than before to pull from more artists

    if not top_artist_ids:
        return []

    # Track metadata only — no embedding column. Per-track similarity
    # against prompt and taste vectors is fetched via RPC below so we
    # never pull tracks.embedding (vector(1024)) over HTTPS.
    tracks_resp = (
        client.table("tracks")
        .select("id,name,artist_id,album_name,release_date,duration_ms,popularity,spotify_track_id,explicit,energy,danceability,valence,tempo,acousticness,instrumentalness,speechiness")
        .in_("artist_id", top_artist_ids)
        .range(0, 9999)
        .execute()
    )
    all_tracks = tracks_resp.data or []

    # Explicit searches are different from normal Discover: the user may ask
    # for a narrow style whose best matching tracks sit outside their usual
    # artist frontier. Pull the indexed track-embedding catalog into the pool
    # so searched-only songs can compete on track-level context similarity.
    if has_explicit_prompt and prompt_vector:
        try:
            search_tracks_resp = (
                client.table("tracks")
                .select("id,name,artist_id,album_name,release_date,duration_ms,popularity,spotify_track_id,explicit,energy,danceability,valence,tempo,acousticness,instrumentalness,speechiness,embedding")
                .not_.is_("embedding", "null")
                .range(0, 9999)
                .execute()
            )
            seen_track_keys = {
                t.get("spotify_track_id") or t.get("id")
                for t in all_tracks
                if t.get("spotify_track_id") or t.get("id")
            }
            search_tracks = []
            for track in search_tracks_resp.data or []:
                track_key = track.get("spotify_track_id") or track.get("id")
                if not track_key or track_key in seen_track_keys:
                    continue
                search_tracks.append(track)
                seen_track_keys.add(track_key)

            if search_tracks:
                all_tracks.extend(search_tracks)
                artist_lookup = {
                    int(a["id"]): a
                    for a in all_artists
                    if a.get("id") is not None
                }
                search_artist_ids: set[int] = set()
                added_artist_ids: list[int] = []
                for track in search_tracks:
                    aid = track.get("artist_id")
                    if aid is None:
                        continue
                    aid_int = int(aid)
                    search_artist_ids.add(aid_int)
                    if aid_int in artist_scores:
                        continue
                    artist = artist_lookup.get(aid_int)
                    if not artist:
                        continue
                    vec = _parse_vector(artist.get("embedding"))
                    raw = _cosine_similarity(taste_vector, vec) if taste_vector and vec else 0.0
                    affinity = _normalize_01(raw) if vec else 0.0
                    artist_scores[aid_int] = {
                        "base_score": weights["affinity"] * affinity,
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
                    added_artist_ids.append(aid_int)
                top_artist_ids.extend(
                    a for a in search_artist_ids if a in artist_scores and a not in top_artist_ids
                )
                print(
                    f"song_ranking: explicit search added {len(search_tracks)} "
                    f"track-embedding candidates across {len(added_artist_ids)} artists"
                )
        except Exception as _e:
            print(f"song_ranking: explicit search track scan failed (non-fatal): {_e}")

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
                extra_tracks_resp = (
                    client.table("tracks")
                    .select("id,name,artist_id,album_name,release_date,duration_ms,popularity,spotify_track_id,explicit,energy,danceability,valence,tempo,acousticness,instrumentalness,speechiness")
                    .in_("artist_id", extra_artist_ids)
                    .range(0, 9999)
                    .execute()
                )
                extra_tracks = extra_tracks_resp.data or []
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

    def _local_track_similarity(t: dict, vector: list[float] | None) -> float | None:
        if not vector:
            return None
        track_vec = _parse_vector(t.get("embedding"))
        if not track_vec:
            return None
        return _cosine_similarity(vector, track_vec)

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
        local_ctx = _local_track_similarity(t, effective_prompt_vector)
        if effective_prompt_vector and tid is not None and (tid in track_context_sim or local_ctx is not None):
            ctx = _normalize_01(track_context_sim[tid] if tid in track_context_sim else local_ctx or 0.0)
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
            local_context = _local_track_similarity(track, effective_prompt_vector)
            local_taste = _local_track_similarity(track, taste_vector)
            if tid_lookup is not None and (
                tid_lookup in track_context_sim
                or tid_lookup in track_taste_sim
                or local_context is not None
                or local_taste is not None
            ):
                used_track_embedding = True
                if effective_prompt_vector:
                    if tid_lookup in track_context_sim:
                        track_context = _normalize_01(track_context_sim[tid_lookup])
                    elif local_context is not None:
                        track_context = _normalize_01(local_context)
                # Blend track-level taste similarity with artist affinity
                # so tracks whose description aligns with the user's taste
                # rank above generic ones. Skip the blend for new users
                # with no taste vector — artist-level affinity is already 0.
                if taste_vector and (tid_lookup in track_taste_sim or local_taste is not None):
                    taste_raw = track_taste_sim[tid_lookup] if tid_lookup in track_taste_sim else local_taste or 0.0
                    track_affinity_raw = _normalize_01(taste_raw)
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

            raw_release = track.get("release_date")
            release_age = _release_age_days(raw_release, now)

            # Track-level boost: popularity is only a confidence hint. Old,
            # very popular songs are deliberately cooled down so the station
            # does not drift into greatest-hits mode.
            track_boost = 0.86 + (0.10 * track_pop)  # 0.86–0.96 range

            # New-release bonus: up to +15% for tracks released in the last
            # calendar year, decaying linearly to 0 at 365 days old.
            if release_age is not None and release_age < 365:
                track_boost *= 1.0 + 0.15 * (1.0 - release_age / 365)
            elif track_pop >= 0.78:
                track_boost *= 0.82
            elif track_pop >= 0.68:
                track_boost *= 0.92

            # Familiarity: penalize songs the user has already heard,
            # but welcome NEW songs from familiar artists (deep cuts are
            # valuable discoveries even from artists you already know).
            in_library = track_id in user_track_map if track_id else False
            is_library_artist = aid in library_artist_ids
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
                track_boost *= 1.20
            elif track_pop < 0.55 and not in_library:
                track_boost *= 1.10

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

            novelty = _novelty_score(
                track_pop,
                a_info["editorial"],
                in_library,
                is_library_artist,
                release_age,
            )
            track_boost *= 0.92 + 0.18 * novelty

            # Exploration
            exploration = rng.uniform(-EXPLORATION_STRENGTH, EXPLORATION_STRENGTH)

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
            if release_age is not None and release_age < 365:
                reasons.append("New release")
            if in_library:
                reasons.append("Already in your library")
            elif is_library_artist and not in_library:
                reasons.append("Deep cut from an artist you love")
            if aid in excluded_artist_ids:
                reasons.append("Recently surfaced")
            if not reasons:
                reasons.append("Curated pick")

            lane = _lane_for_track(
                track_pop,
                a_info["genres"],
                reasons,
                a_info["editorial"],
                release_age,
            )

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
                "signals": {
                    "affinity": round(track_affinity, 4),
                    "context": round(track_context, 4),
                    "editorial": round(a_info["editorial"], 4),
                    "track_popularity": round(track_pop, 4),
                    "novelty": round(novelty, 4),
                    "familiarity": round(1.0 - novelty, 4),
                    "track_embedding": used_track_embedding,
                },
                "lane": lane,
                "genres": a_info["genres"],
                "reasons": reasons,
                "mention_count": a_info["mention_count"],
                "top_mention": a_info["best_mention"],
            })

    # Sort by score
    song_results.sort(key=lambda s: s["score"], reverse=True)

    # ── Lane-aware diversity re-ranking ──────────────────────────
    # The old path sorted one blended list and let hits crowd out discovery.
    # This enforces a Pandora-like station mix: some recognizable anchors,
    # plenty of solid popular cuts, and a real deep-cut lane.
    diverse = _lane_aware_rerank(song_results, max(limit, 0))

    return diverse


def _song_diversity_rerank(scored: list[dict], limit: int) -> list[dict]:
    """Re-rank songs for genre + artist diversity.

    The artist cap is enforced unconditionally — even when the input pool
    is smaller than `limit`, we still need to drop near-duplicate songs
    from the same artist (e.g. multiple radio edits of the same track).
    """
    if not scored or limit <= 0:
        return []

    # Give the greedy selector a wide pool so it can find diverse candidates.
    # Keep a generous floor for narrow explicit searches where the best style
    # match can sit outside the first few score bands.
    rerank_pool_size = max(limit * 15, 500)
    pool = scored if len(scored) <= rerank_pool_size else scored[:rerank_pool_size]
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
            all_genres = [g.lower() for g in genres] or ["__none__"]
            artist = candidate["artist_name"].lower()

            # Artist cap
            if artist_counts.get(artist, 0) >= MAX_ARTIST_SONGS:
                continue

            # Genre diversity penalty: check saturation across ALL genres, not
            # just genres[0] (Spotify's ordering is arbitrary).
            max_genre_share = max(
                genre_counts.get(g, 0.0) / max(len(selected), 1) for g in all_genres
            )
            penalty = 0.7 if max_genre_share >= MAX_GENRE_FRACTION else 1.0

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

        pick_genres = [g.lower() for g in (pick.get("genres") or [])] or ["__none__"]
        n_pick_genres = len(pick_genres)
        for g in pick_genres:
            genre_counts[g] += 1.0 / n_pick_genres  # distribute across all genres equally
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


def _lane_targets(limit: int) -> dict[str, int]:
    if limit <= 0:
        return {lane: 0 for lane in DISCOVERY_LANES}
    radio_hits = max(1, round(limit * 0.18))
    deep_cuts = max(2, round(limit * 0.38))
    popular = max(0, limit - radio_hits - deep_cuts)
    return {
        "deep_cuts": deep_cuts,
        "popular": popular,
        "radio_hits": radio_hits,
    }


def _candidate_key(candidate: dict) -> str:
    spotify_id = candidate.get("spotify_track_id")
    if spotify_id:
        return f"spotify:{spotify_id}"
    return f"{candidate.get('track_name', '')}|{candidate.get('artist_name', '')}".lower()


def _pick_lane_candidates(
    pool: list[dict],
    target: int,
    used: set[str],
    artist_counts: Counter[str],
    genre_counts: Counter[str],
    strict_artist_cap: int = 1,
) -> list[dict]:
    picks: list[dict] = []
    if target <= 0:
        return picks

    while len(picks) < target:
        best_idx = -1
        best_adjusted = -1.0

        for i, candidate in enumerate(pool):
            key = _candidate_key(candidate)
            if key in used:
                continue

            artist = (candidate.get("artist_name") or "").lower()
            if artist_counts.get(artist, 0) >= strict_artist_cap:
                continue

            genres = [g.lower() for g in (candidate.get("genres") or [])] or ["__none__"]
            max_genre_share = max(
                genre_counts.get(g, 0.0) / max(len(used), 1) for g in genres
            )
            genre_penalty = 0.72 if max_genre_share >= 0.34 else 1.0
            novelty = float((candidate.get("signals") or {}).get("novelty") or 0.0)
            lane_bonus = 1.0 + (0.08 * novelty if candidate.get("lane") == "deep_cuts" else 0.0)
            adjusted = float(candidate.get("score") or 0.0) * genre_penalty * lane_bonus

            if adjusted > best_adjusted:
                best_adjusted = adjusted
                best_idx = i

        if best_idx < 0:
            break

        pick = pool[best_idx]
        key = _candidate_key(pick)
        used.add(key)
        picks.append(pick)
        artist_counts[(pick.get("artist_name") or "").lower()] += 1
        genres = [g.lower() for g in (pick.get("genres") or [])] or ["__none__"]
        for genre in genres:
            genre_counts[genre] += 1.0 / max(len(genres), 1)

    return picks


def _lane_aware_rerank(scored: list[dict], limit: int) -> list[dict]:
    if not scored or limit <= 0:
        return []

    pools: dict[str, list[dict]] = {lane: [] for lane in DISCOVERY_LANES}
    for row in scored:
        lane = row.get("lane") if row.get("lane") in DISCOVERY_LANES else "popular"
        pools[lane].append(row)

    for lane, rows in pools.items():
        rows.sort(
            key=lambda r: (
                float((r.get("signals") or {}).get("novelty") or 0.0)
                if lane == "deep_cuts"
                else float(r.get("score") or 0.0),
                float(r.get("score") or 0.0),
            ),
            reverse=True,
        )

    targets = _lane_targets(limit)
    selected: list[dict] = []
    used: set[str] = set()
    artist_counts: Counter[str] = Counter()
    genre_counts: Counter[str] = Counter()

    # Fill lanes from discovery-first to recognition anchors. Radio hits are
    # intentionally last and capped unless the catalog has nothing else.
    for lane in ("deep_cuts", "popular", "radio_hits"):
        selected.extend(
            _pick_lane_candidates(
                pools[lane],
                targets[lane],
                used,
                artist_counts,
                genre_counts,
            )
        )

    if len(selected) < limit:
        non_hit_pool = [
            row
            for row in scored
            if row.get("lane") != "radio_hits" and _candidate_key(row) not in used
        ]
        selected.extend(
            _pick_lane_candidates(
                non_hit_pool,
                limit - len(selected),
                used,
                artist_counts,
                genre_counts,
            )
        )

    if len(selected) < limit:
        selected.extend(
            _pick_lane_candidates(
                scored,
                limit - len(selected),
                used,
                artist_counts,
                genre_counts,
            )
        )

    if len(selected) < limit:
        selected.extend(
            _pick_lane_candidates(
                scored,
                limit - len(selected),
                used,
                artist_counts,
                genre_counts,
                strict_artist_cap=2,
            )
        )

    return selected[:limit]
