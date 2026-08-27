"""Song-level recommendation engine.

Extends the artist-level ranking to produce individual song recommendations.
Uses artist embeddings as the foundation, then ranks individual tracks by
combining artist-level signals with track-specific metadata:

  song_score = artist_score × track_boost

Where track_boost incorporates:
  - Track popularity (Spotify's 0–100 normalized)
  - Recency bonus for recently released tracks
  - Explicit preference alignment
  - Familiarity penalty (reduce songs from the user's own library)

Results are deduplicated by track name (case-insensitive) and diversity-reranked.
"""

from __future__ import annotations

import math
import random
import time as _time
from collections import Counter, defaultdict
from datetime import datetime, timezone

from supabase import Client

from app.services.ranking import (
    _cosine_similarity,
    _get_listen_counts_for_tracks,
    _get_user_library_artist_ids,
    _get_previously_recommended_artist_ids,
    _get_user_artist_weights,
    _get_user_feedback,
    _normalize_01,
    _parse_vector,
    _percentile_rank,
)
from app.services.preference_weights import recency_multiplier, track_preference_weight
from app.services.track_quality import (
    prompt_requests_utility_tracks,
    should_exclude_utility_track,
)
from app.services.vector_rpc import (
    match_artists,
    match_tracks,
    max_mention_similarity_per_artist,
    track_similarity_for_artists,
    user_favorites_centroid,
)

# Pure scoring / lane / strategy helpers live in song_scoring so they can be
# unit-tested without the DB-bound orchestrator below. Re-imported here because
# the orchestrator and rerankers reference them by their original names.
from app.services.song_scoring import (
    DEFAULT_DISCOVERY_MIX,
    DISCOVERY_LANES,
    FAVORITES_REASON_THRESHOLD,
    _AUDIO_DIM_WEIGHT_TOTAL,
    _AUDIO_DIMENSION_WEIGHTS,
    _artist_recognizability,
    _track_recognizability,
    _within_artist_recognizability,
    _candidate_key,
    _clean_strategy,
    _deep_cut_quality,
    _favorites_boost,
    _freshness_strategy_multiplier,
    _genre_strategy_multiplier,
    _genre_tokens_for_prompt,
    _lane_for_track,
    _lane_targets,
    _novelty_score,
    _release_age_days,
    classify_prompt,
)


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
            .select("id,name,artist_id,album_name,release_date,duration_ms,popularity,lastfm_listeners,spotify_track_id,explicit,energy,danceability,valence,tempo,acousticness,instrumentalness,speechiness")
            .in_("artist_id", chunk)
            .range(0, 9999)
            .execute()
        )
        tracks.extend(resp.data or [])
    return tracks


def recommend_songs(
    client: Client,
    user_id: str,
    taste_vector: list[float],
    prompt_vector: list[float] | None,
    weights: dict[str, float],
    exclude_library: bool,
    limit: int,
    exclude_saved_tracks: bool = True,
    prompt_text: str | None = None,
    excluded_track_ids: set[str] | None = None,
    excluded_artist_ids: set[int] | None = None,
    exploration_seed: int | None = None,
    taste_strategy: dict | None = None,
    taste_clusters: list[list[float]] | None = None,
    performance_timings: dict[str, int] | None = None,
) -> list[dict]:
    """Return a ranked list of song-level recommendations.

    If prompt_text looks like a genre (matches known genres in the DB),
    results are filtered to only include artists with matching genres.
    This makes searches like 'alternative rock' or 'hip-hop' work as
    genre filters rather than just embedding similarity.
    """

    strategy = _clean_strategy(taste_strategy)
    stage_timings = performance_timings if performance_timings is not None else {}

    def _record_stage(key: str, started_at: float) -> None:
        elapsed_ms = round((_time.monotonic() - started_at) * 1000)
        stage_timings[key] = stage_timings.get(key, 0) + elapsed_ms
    artist_weights = _get_user_artist_weights(client, user_id)
    library_artist_ids = _get_user_library_artist_ids(client, user_id, saved_only=True)
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
            .select("spotify_track_id,feedback,reason")
            .eq("user_id", user_id)
            .range(0, 9999)
            .execute()
        )
        track_feedback: dict[str, int] = {
            row["spotify_track_id"]: int(row["feedback"])
            for row in (track_fb_resp.data or [])
            if row.get("spotify_track_id") and row.get("feedback") is not None
        }
        track_feedback_reasons: dict[str, str] = {
            row["spotify_track_id"]: str(row.get("reason") or "")
            for row in (track_fb_resp.data or [])
            if row.get("spotify_track_id") and row.get("reason")
        }
    except Exception:
        track_feedback = {}
        track_feedback_reasons = {}

    try:
        event_resp = (
            client.table("recommendation_events")
            .select("spotify_track_id,artist_id,event_type")
            .eq("user_id", user_id)
            .range(0, 9999)
            .execute()
        )
        track_events: dict[str, Counter[str]] = defaultdict(Counter)
        artist_events: dict[int, Counter[str]] = defaultdict(Counter)
        for row in event_resp.data or []:
            event_type = str(row.get("event_type") or "")
            spotify_tid = row.get("spotify_track_id")
            if spotify_tid:
                track_events[str(spotify_tid)][event_type] += 1
            aid = row.get("artist_id")
            if aid is not None:
                artist_events[int(aid)][event_type] += 1
    except Exception:
        track_events = defaultdict(Counter)
        artist_events = defaultdict(Counter)

    excluded_artist_ids = excluded_artist_ids or set()

    # ── Candidate pool via pgvector RPC ──────────────────────────
    # Discovery cannot feel fresh if every click only considers the same top
    # few hundred taste-nearest artists. Pull a wider frontier, then sample
    # below the obvious head of the list later.
    POOL_SIZE = max(limit * 50, 1500)

    # Only use hard genre filtering when the prompt actually names a genre.
    # Mood prompts like "sad night drive" should stay semantic; treating every
    # token as a genre filter made searches feel oddly literal.
    genre_tokens = _genre_tokens_for_prompt(prompt_text)

    artist_match_started = _time.monotonic()
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

    # ── Multi-centroid retrieval ──────────────────────────────────
    # A single centroid averages multi-genre listeners into the middle of
    # embedding space. When the taste profile has distinct clusters, pull a
    # secondary pool near each additional cluster and merge by max similarity,
    # so every taste mode gets candidates that are *strong* matches to it.
    secondary_clusters = (taste_clusters or [])[1:]
    if secondary_clusters and not genre_filtered:
        by_id: dict[int, dict] = {
            int(a["id"]): a for a in all_artists if a.get("id") is not None
        }
        for cluster_vector in secondary_clusters[:2]:
            cluster_artists = match_artists(
                client,
                query_vector=cluster_vector,
                match_count=POOL_SIZE // 2,
            )
            for row in cluster_artists:
                if row.get("id") is None:
                    continue
                rid = int(row["id"])
                existing = by_id.get(rid)
                if existing is None:
                    by_id[rid] = row
                elif float(row.get("similarity") or 0.0) > float(existing.get("similarity") or 0.0):
                    existing["similarity"] = row.get("similarity")
        all_artists = list(by_id.values())
        print(
            f"song_ranking: multi-centroid retrieval merged "
            f"{len(secondary_clusters[:2])} extra cluster pool(s) -> "
            f"{len(all_artists)} candidate artists"
        )
    _record_stage("artist_match_rpc_ms", artist_match_started)

    # ── Recognizability (popularity replacement) ──────────────────
    # Spotify stopped returning popularity scores; Last.fm listener counts
    # (via migration 028 + the lastfm-stats backfill) become a pool-relative
    # percentile. Tracks with an explicit popularity value keep using it;
    # everything else inherits the artist's recognizability percentile.
    artist_recognizability = _artist_recognizability(all_artists)
    if artist_recognizability:
        print(
            f"song_ranking: recognizability percentiles for "
            f"{len(artist_recognizability)}/{len(all_artists)} pool artists"
        )

    # Track-level recognizability percentiles, populated once the candidate
    # tracks are fetched in Phase 2. Both are read through closures below, so
    # they are mutated in place rather than rebound.
    #   track_recognizability        — reach percentile across the whole pool
    #   within_artist_recognizability — reach percentile inside one catalog
    track_recognizability: dict[int, float] = {}
    within_artist_recognizability: dict[int, float] = {}

    def _effective_track_pop(track: dict, artist_id: int | None) -> float:
        raw = track.get("popularity")
        if raw is not None:
            return float(raw) / 100.0
        track_id = track.get("id")
        if track_id is not None:
            ranked = track_recognizability.get(track_id)
            if ranked is not None:
                return ranked
        # No per-track signal yet (backfill still converging): fall back to the
        # artist percentile, which is what every track used to get.
        if artist_id is not None:
            return artist_recognizability.get(artist_id, 0.5)
        return 0.5

    # ── Fetch user's track data for familiarity detection ─────
    # Paginate to handle users with very large libraries (>9999 tracks).
    user_track_map: dict[int, dict] = {}
    _ut_offset = 0
    _ut_page = 1000
    while True:
        _ut_resp = (
            client.table("user_tracks")
            .select("track_id,play_count,last_played_at,added_at")
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

    now = datetime.now(timezone.utc)

    # ── User audio feature profile ─────────────────────────────
    # Build a sound fingerprint from intentionally saved library tracks.
    # Recently-played Spotify rows can be generated by MusicLife Radio itself,
    # so they should only protect against repeats, not steer taste.
    _AUDIO_FEATS = ("energy", "danceability", "valence", "acousticness", "instrumentalness")
    user_audio_pref: dict[str, float] | None = None
    saved_instrumental_track_count = 0
    saved_instrumental_weight = 0.0
    saved_known_instrumental_weight = 0.0
    saved_track_map = {
        tid: row
        for tid, row in user_track_map.items()
        if row.get("added_at") and track_preference_weight(row, now) > 0
    }
    saved_track_ids = set(saved_track_map.keys())
    saved_listen_counts = _get_listen_counts_for_tracks(
        client,
        user_id,
        list(saved_track_ids),
    )
    artist_saved_listen_counts: dict[int, int] = defaultdict(int)
    if saved_listen_counts:
        try:
            track_artist_rows: list[dict] = []
            for chunk in _chunked(list(saved_listen_counts.keys()), 200):
                track_artist_rows.extend(
                    client.table("tracks")
                    .select("id,artist_id")
                    .in_("id", chunk)
                    .range(0, 9999)
                    .execute()
                    .data
                    or []
                )
            for track_row in track_artist_rows:
                tid = track_row.get("id")
                aid = track_row.get("artist_id")
                if tid is None or aid is None:
                    continue
                artist_saved_listen_counts[int(aid)] += saved_listen_counts.get(int(tid), 0)
        except Exception:
            artist_saved_listen_counts = defaultdict(int)
    max_saved_listens = max(artist_saved_listen_counts.values(), default=0)
    artist_listen_boost = {
        artist_id: min(1.0, math.log1p(count) / math.log1p(max(max_saved_listens, 1)))
        for artist_id, count in artist_saved_listen_counts.items()
    }
    if saved_track_map:
        def _effective_weight(tid: int) -> float:
            _entry = saved_track_map.get(tid)
            if not _entry:
                return 1.0
            weighted_entry = dict(_entry)
            weighted_entry["listen_count"] = saved_listen_counts.get(tid, 0)
            return track_preference_weight(weighted_entry, now)

        _audio_ids = sorted(
            saved_track_map.keys(),
            key=_effective_weight,
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
                _play = max(_effective_weight(_tid), 0.1)
                _has_feat = False
                for _feat in _AUDIO_FEATS:
                    _v = _t.get(_feat)
                    if _v is not None:
                        _feat_totals[_feat] += float(_v) * _play
                        _has_feat = True
                _instrumentalness = _t.get("instrumentalness")
                if _instrumentalness is not None:
                    saved_known_instrumental_weight += _play
                    if float(_instrumentalness) > 0.65:
                        saved_instrumental_track_count += 1
                        saved_instrumental_weight += _play
                if _has_feat:
                    _feat_weight += _play
            if _feat_weight > 0 and len(_feat_totals) >= 2:
                user_audio_pref = {k: v / _feat_weight for k, v in _feat_totals.items()}
                print(f"song_ranking: audio profile built from {len(_audio_ids)} saved library tracks — "
                      f"energy={user_audio_pref.get('energy', 0):.2f} "
                      f"dance={user_audio_pref.get('danceability', 0):.2f} "
                      f"valence={user_audio_pref.get('valence', 0):.2f}")
            else:
                # Spotify deprecated /audio-features (Nov 2024), so these
                # columns are unpopulated for catalogs built after that. Make
                # the inactive audio path observable instead of silently
                # disabling the audio_match signal for every track.
                print(
                    "song_ranking: audio profile inactive — no usable audio "
                    f"features across {len(_audio_ids)} saved tracks; "
                    "audio_match scoring disabled for this request"
                )
        except Exception as _e:
            print(f"song_ranking: audio profile failed (non-fatal): {_e}")

    # ── Source/mention data for editorial + context signals ────
    candidate_ids = [int(a["id"]) for a in all_artists if a.get("id")]

    mention_fetch_started = _time.monotonic()
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
    _record_stage("mention_fetch_ms", mention_fetch_started)

    recent_window_days = 45

    effective_prompt_vector = prompt_vector if prompt_vector else taste_vector
    has_explicit_prompt = prompt_vector is not None
    user_prefers_instrumental = bool(
        user_audio_pref
        and user_audio_pref.get("instrumentalness", 0.0) > 0.6
        and saved_instrumental_track_count >= 3
        and saved_known_instrumental_weight > 0
        and saved_instrumental_weight / saved_known_instrumental_weight >= 0.65
    )
    allow_instrumental_utility_tracks = (
        user_prefers_instrumental or prompt_requests_utility_tracks(prompt_text)
    )

    # When there's no explicit prompt, zero out the context weight and
    # redistribute it to affinity. The old behavior used the taste vector
    # as a proxy for context, but this made the context signal identical
    # to affinity — every artist scored ~0.75 context for every user,
    # drowning out the actual per-user taste differences.
    if not has_explicit_prompt:
        redistributed = weights.get("context", 0.0)
        weights = {
            "affinity": weights["affinity"] + redistributed * 0.35,
            "context": 0.0,
            "editorial": weights["editorial"] + redistributed * 0.65,
        }

    station_distance = strategy.get("station_distance", "balanced")
    familiarity_pref = strategy.get("familiarity", "balanced")
    if not has_explicit_prompt:
        if station_distance == "closer":
            weights = {
                "affinity": weights["affinity"] * 1.14,
                "context": weights["context"],
                "editorial": weights["editorial"] * 0.78,
            }
        elif station_distance == "further":
            weights = {
                "affinity": weights["affinity"] * 0.88,
                "context": weights["context"],
                "editorial": weights["editorial"] * 1.18,
            }
        total_weight = sum(weights.values())
        if total_weight > 0:
            weights = {key: value / total_weight for key, value in weights.items()}

    # Per-artist max(cosine(prompt|taste, mention.embedding)) computed in
    # SQL — replaces the in-process pass that needed every mention vector.
    # Computed whenever there's an effective query vector so the context
    # signal value is still populated when the weight has been redistributed
    # to 0 (mood-fallback path).
    if effective_prompt_vector and candidate_ids:
        mention_context_started = _time.monotonic()
        context_by_artist = max_mention_similarity_per_artist(
            client, effective_prompt_vector, candidate_ids
        )
        _record_stage("mention_context_rpc_ms", mention_context_started)
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
            # sorted() because slicing a set takes an arbitrary 500 artists,
            # so the user's genre weights (and every downstream boost) shifted
            # between otherwise identical requests.
            .in_("id", sorted(library_artist_ids)[:500])
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
            # max_w can be 0 (or negative) when every contributing artist's
            # weight nets to zero — e.g. play-count signal exactly canceled
            # by thumbs-down feedback. The `if genre_totals` check above
            # only catches an *empty* dict, not all-zero values, so without
            # this guard the dict comprehension raises ZeroDivisionError
            # and /recommend-songs returns 500. Skip normalization in that
            # case; the downstream genre-boost path treats an empty
            # user_genre_weights as "no signal" and degrades gracefully.
            if max_w > 0:
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
    hard_exclude_recent_artists = (
        bool(excluded_artist_ids)
        and not has_explicit_prompt
        and non_recent_artist_count >= max(limit * 3, 30)
    )
    if hard_exclude_recent_artists:
        print(
            f"song_ranking: hard-excluding {len(excluded_artist_ids)} recent artists; "
            f"{non_recent_artist_count} alternatives available"
        )
    elif excluded_artist_ids and not has_explicit_prompt and non_recent_artist_count < max(limit * 3, 30):
        print(
            f"song_ranking: skipping hard-exclude — only {non_recent_artist_count} "
            f"non-recent artists available (need {max(limit * 3, 30)}); using soft penalty instead"
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

    # NOTE: a "universal attractor" penalty used to sit here, multiplying the
    # top ~8% of this pool by 0.75 on the theory that they were artists
    # centrally located in embedding space that score high for *every* user.
    # It never had cross-user data to work from: it took the 92nd percentile
    # of this one user's own cosine similarities within this one request's
    # pool. Since the pool is ordered by similarity to the user's taste
    # vector, the artists it demoted were by construction that user's
    # strongest matches. Removed rather than reimplemented — detecting a
    # genuine attractor needs a corpus-wide statistic (e.g. an artist's mean
    # similarity across all taste vectors), not a within-request percentile.

    # Use stronger exploration for non-prompted queries so browsing feels
    # fresh and different between users.  With a prompt the user has a
    # specific intent and results should be more deterministic.
    if has_explicit_prompt:
        EXPLORATION_STRENGTH = 0.03
        ARTIST_JITTER = 0.0
    else:
        EXPLORATION_STRENGTH = {
            "closer": 0.018,
            "balanced": 0.012,
            "further": 0.045,
        }.get(station_distance, 0.012)
        ARTIST_JITTER = {
            "closer": 0.015,
            "balanced": 0.015,
            "further": 0.045,
        }.get(station_distance, 0.015)
    rng = random.Random(exploration_seed) if exploration_seed is not None else random
    excluded_track_ids = excluded_track_ids or set()
    excluded_artist_ids = excluded_artist_ids or set()
    # Artist-level jitter: add a small random perturbation to each artist's
    # base score so that artists near the score boundary rotate in/out each
    # request. Without this, the same N artists always win Phase 1 and results
    # feel identical even when individual tracks are excluded.

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

        # ── Taste diversity bonus ──────────────────────────────
        # When a user likes multiple genres (jazz + electronic), the single
        # taste centroid sits between them, giving mediocre affinity to
        # everything. Rescue artists that match a strong user genre but
        # scored poorly against the averaged centroid.
        if user_genre_weights and artist_genres and affinity <= 0.65:
            _best_genre_match = max(
                (user_genre_weights.get(g, 0.0) for g in artist_genres),
                default=0.0,
            )
            if _best_genre_match >= 0.4:
                _gap = max(0.0, 0.65 - affinity)
                affinity = min(1.0, affinity + min(0.15, _gap * _best_genre_match * 0.5))

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

        # Editorial floor: when editorial is non-trivial but being drowned
        # out by affinity, add a small floor so editorially-covered artists
        # aren't invisible in unprompted discovery.
        if not has_explicit_prompt and editorial > 0.1:
            _aff_contrib = weights["affinity"] * affinity
            _ed_contrib = weights["editorial"] * editorial
            if _aff_contrib > 0 and _ed_contrib / _aff_contrib < 0.08:
                base_score += editorial * 0.06

        if aid in previously_recommended:
            base_score *= 0.90 if has_explicit_prompt else 0.70

        if aid in excluded_artist_ids:
            base_score *= 0.70 if has_explicit_prompt else 0.35

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
    track_fetch_started = _time.monotonic()
    all_tracks = _fetch_tracks_for_artist_ids(client, top_artist_ids)
    _record_stage("track_fetch_ms", track_fetch_started)

    # Explicit searches are different from normal Discover: the user may ask
    # for a narrow style whose best matching tracks sit outside their usual
    # artist frontier. Pull the indexed track-embedding catalog into the pool
    # so searched-only songs can compete on track-level context similarity.
    if has_explicit_prompt and prompt_vector:
        try:
            track_match_started = _time.monotonic()
            search_tracks_resp = match_tracks(
                client,
                query_vector=prompt_vector,
                match_count=max(limit * 30, 300),
                genre_tokens=genre_tokens,
            )
            seen_track_keys = {
                t.get("spotify_track_id") or t.get("id")
                for t in all_tracks
                if t.get("spotify_track_id") or t.get("id")
            }
            search_tracks = []
            for track in search_tracks_resp:
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
            _record_stage("track_match_rpc_ms", track_match_started)
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
                extra_track_fetch_started = _time.monotonic()
                extra_tracks = _fetch_tracks_for_artist_ids(client, extra_artist_ids)
                _record_stage("track_fetch_ms", extra_track_fetch_started)
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
        track_id = t.get("id")
        if exclude_saved_tracks and track_id in saved_track_ids:
            continue
        if excluded_track_ids and (t.get("spotify_track_id") or "") in excluded_track_ids:
            continue
        if should_exclude_utility_track(
            t,
            allow_instrumental_utility=allow_instrumental_utility_tracks,
        ):
            continue
        tracks_by_artist[int(aid)].append(t)

    # ── Track-level recognizability ───────────────────────────────
    # Computed over the surviving candidate pool so percentiles reflect what
    # is actually rankable this request. Until migration 030's backfill has
    # covered enough of the catalog these come back empty and every track
    # falls back to its artist's percentile, exactly as before.
    candidate_tracks = [t for rows in tracks_by_artist.values() for t in rows]
    track_recognizability.update(_track_recognizability(candidate_tracks))
    within_artist_recognizability.update(
        _within_artist_recognizability(candidate_tracks)
    )
    if track_recognizability:
        print(
            f"song_ranking: track recognizability for "
            f"{len(track_recognizability)}/{len(candidate_tracks)} candidate tracks; "
            f"{len(within_artist_recognizability)} ranked within their catalog"
        )
    else:
        print(
            f"song_ranking: no track-level recognizability across "
            f"{len(candidate_tracks)} candidates — falling back to artist "
            "percentiles (run the track-stats backfill to enable it)"
        )

    # ── Per-track cosine similarity via RPC (no embedding pulled) ─
    # SQL calls (prompt context, taste affinity, favorites proximity) replace
    # what used to be a streaming pull of every tracks.embedding row.
    track_context_sim: dict[int, float] = {}
    track_taste_sim: dict[int, float] = {}
    track_favorites_sim: dict[int, float] = {}
    favorites_vector: list[float] = []
    if top_artist_ids:
        track_match_started = _time.monotonic()
        if effective_prompt_vector:
            track_context_sim = track_similarity_for_artists(
                client, effective_prompt_vector, top_artist_ids
            )
        if taste_vector:
            track_taste_sim = track_similarity_for_artists(
                client, taste_vector, top_artist_ids
            )
        # Hearts as a positive signal: tracks near the centroid of the user's
        # favorited songs get a bounded boost (previously favorites were only
        # an exclusion). Empty when the user has no favorites yet.
        favorites_vector = user_favorites_centroid(client, user_id)
        if favorites_vector:
            track_favorites_sim = track_similarity_for_artists(
                client, favorites_vector, top_artist_ids
            )
        _record_stage("track_match_rpc_ms", track_match_started)

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
    def _track_audio_match(t: dict) -> float | None:
        if not user_audio_pref:
            return None
        known = [k for k in _AUDIO_DIMENSION_WEIGHTS if t.get(k) is not None]
        if len(known) < 2:
            return None
        weighted_diff_sq = sum(
            _AUDIO_DIMENSION_WEIGHTS[k] *
            (float(t.get(k) or 0.5) - user_audio_pref.get(k, 0.5)) ** 2
            for k in _AUDIO_DIMENSION_WEIGHTS
        )
        return max(0.0, min(1.0, 1.0 - math.sqrt(weighted_diff_sq / _AUDIO_DIM_WEIGHT_TOTAL)))

    def _track_shortlist_score(t: dict) -> float:
        """Score a track for shortlist selection within an artist's catalog.

        This decides *which* of an artist's songs represents them, so the
        dominant signal is how well known the track is inside that artist's
        own catalog — a signature song should beat an interlude, a live
        version, or a bonus-disc remix regardless of how big the artist is.

        Signals are averaged over whatever is actually available rather than
        defaulted to a constant. Audio features are NULL catalog-wide since
        Spotify retired /audio-features, and folding in a constant 0.5 for
        them only diluted the signals that do exist. A small jitter is added
        on top for rotation across the novelty retry attempts (seed 0–4) —
        deliberately too small to promote filler over a known song.

        Per-track similarity comes from the SQL RPC; no embedding crosses
        the wire.
        """
        try:
            _shortlist_aid = int(t["artist_id"]) if t.get("artist_id") is not None else None
        except (TypeError, ValueError):
            _shortlist_aid = None
        if should_exclude_utility_track(
            t,
            allow_instrumental_utility=allow_instrumental_utility_tracks,
        ):
            return -1.0

        tid = t.get("id")
        # Prefer the within-catalog percentile; it is scale-free, so a mid-tier
        # artist's best song scores as highly as a superstar's best song and
        # the shortlist stops being decided by how famous the artist is.
        reach = within_artist_recognizability.get(tid) if tid is not None else None
        if reach is None:
            reach = _effective_track_pop(t, _shortlist_aid)

        audio_match = _track_audio_match(t)
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

        local_ctx = _local_track_similarity(t, effective_prompt_vector)
        ctx: float | None = None
        if effective_prompt_vector and tid is not None and (
            tid in track_context_sim or local_ctx is not None
        ):
            ctx = _normalize_01(
                track_context_sim[tid] if tid in track_context_sim else local_ctx or 0.0
            )

        components: list[tuple[float, float]] = []
        if ctx is not None and has_explicit_prompt:
            # The user asked for something specific, so prompt fit leads and
            # reach breaks ties among the tracks that fit.
            components.append((0.44, ctx))
            components.append((0.34, reach))
        else:
            # Unprompted, `ctx` is similarity to the *taste* vector, which is
            # essentially an artist-level signal: within one catalog it varies
            # mostly with how the title and album happen to be worded, not
            # with whether the song is any good. Let it nudge, not decide.
            components.append((0.62, reach))
            if ctx is not None:
                components.append((0.14, ctx))
        components.append((0.10, recency))
        if audio_match is not None:
            components.append((0.14, audio_match))

        total_weight = sum(weight for weight, _ in components)
        blended = sum(weight * value for weight, value in components) / total_weight

        jitter = 0.04 if has_explicit_prompt else 0.08
        return blended + jitter * rng.random()

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
            # Dedup by both spotify_track_id AND name+artist so the same
            # song from different releases (single vs album, remaster,
            # different markets) doesn't appear twice.
            name_key = f"{track_name.lower()}|{a_info['name'].lower()}"
            if name_key in seen_songs:
                continue
            if spotify_tid and spotify_tid in seen_songs:
                continue
            seen_songs.add(name_key)
            if spotify_tid:
                seen_songs.add(spotify_tid)

            track_id = track.get("id")
            track_pop = _effective_track_pop(track, aid)

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

            if aid in previously_recommended:
                track_base *= 0.92 if has_explicit_prompt else 0.80

            raw_release = track.get("release_date")
            release_age = _release_age_days(raw_release, now)

            # Track-level boost: mildly favors songs people actually know.
            #
            # Keeping the station off greatest-hits autopilot is the lane
            # quotas' job (_lane_targets caps radio_hits at ~18–24% of the
            # result), not the score's. This used to *also* cool popular
            # tracks by up to 18% and *also* pay an obscurity bonus of up to
            # 20% below — so obscurity was bought three times over and a
            # well-known song lost to an album cut by ~35% at equal affinity.
            # One mild popularity shape here; the quota does the rest.
            track_boost = 0.92 + (0.08 * track_pop)  # 0.92–1.00 range

            # New-release bonus: up to +15% for tracks released in the last
            # calendar year, decaying linearly to 0 at 365 days old.
            if release_age is not None and release_age < 365:
                track_boost *= 1.0 + 0.15 * (1.0 - release_age / 365)
            elif track_pop >= 0.92:
                # Only the very top of the pool is trimmed, so a station can
                # still open on a song the listener recognizes without the
                # chart's single biggest track winning every slot.
                track_boost *= 0.96

            # Familiarity: penalize songs the user has already heard,
            # but welcome NEW songs from familiar artists (deep cuts are
            # valuable discoveries even from artists you already know).
            in_library = track_id in user_track_map if track_id else False
            is_saved_track = track_id in saved_track_ids if track_id else False
            is_library_artist = aid in library_artist_ids
            if exclude_saved_tracks and is_saved_track:
                continue
            if exclude_library and in_library:
                continue
            if in_library:
                # Time-decay: a track not played in 6+ months is a rediscovery,
                # not a repeat. Penalty relaxes from 0.45 (recent) → 0.80 (stale).
                # Falls back to added_at when no play data exists.
                _entry = user_track_map.get(track_id) or {}
                _recency_ts = _entry.get("last_played_at") or _entry.get("added_at")
                _freshness = recency_multiplier(_recency_ts, now, floor=0.0, half_life_days=90.0)
                track_boost *= 0.45 + 0.35 * (1.0 - _freshness)
            elif is_library_artist:
                if familiarity_pref == "anchors":
                    track_boost *= 1.03
                elif familiarity_pref == "surprises":
                    track_boost *= 0.82
                else:
                    track_boost *= 0.92
                track_boost *= 1.0 + 0.10 * artist_listen_boost.get(aid, 0.0)
            elif familiarity_pref == "surprises":
                track_boost *= 1.04
            elif familiarity_pref == "anchors":
                track_boost *= 0.94

            if station_distance == "closer":
                track_boost *= 1.04 if is_library_artist else 0.96
            elif station_distance == "further":
                track_boost *= 0.96 if is_library_artist else 1.04

            # NOTE: a flat obscurity bonus (×1.20 below 0.40 reach, ×1.10
            # below 0.55) used to sit here. It rewarded tracks for being
            # unknown rather than for being good, on top of the lane quota
            # that already reserves 38–45% of every station for deep cuts.
            # Deep cuts are now selected on _deep_cut_quality — editorial
            # coverage, taste affinity, prompt fit — inside their own lane,
            # so a great deep cut still wins its slots while a forgettable
            # one no longer outranks a song the listener would recognize.

            # Audio feature alignment: prefer tracks that sound like the user's library.
            audio_match_value = _track_audio_match(track) if user_audio_pref else None
            if user_audio_pref:
                if audio_match_value is None:
                    track_boost *= 0.96
                else:
                    track_boost *= 0.55 + 0.65 * audio_match_value

            # Favorites proximity: bounded multiplicative boost for tracks
            # whose embedding sits near the centroid of the user's hearts.
            favorites_match_value = (
                track_favorites_sim.get(track_id) if track_id is not None else None
            )
            track_boost *= _favorites_boost(favorites_match_value)

            # Instrumental / spoken-word penalty: filter utility tracks
            # (meditation, interludes, podcasts). NULL = unknown, no penalty.
            _instrumentalness = track.get("instrumentalness")
            _speechiness = track.get("speechiness")
            if _instrumentalness is not None and _instrumentalness > 0.8:
                if user_prefers_instrumental:
                    track_boost *= 1.35
                else:
                    track_boost *= 0.35
            elif _instrumentalness is not None and _instrumentalness > 0.5:
                if user_audio_pref:
                    _user_inst = user_audio_pref.get("instrumentalness", 0.5)
                    _inst_gap = max(0.0, _instrumentalness - _user_inst - 0.2)
                    track_boost *= max(0.60, 1.0 - _inst_gap)
                else:
                    track_boost *= 0.70
            if _speechiness is not None and _speechiness > 0.66:
                track_boost *= 0.30

            strategy_genre_mult = _genre_strategy_multiplier(a_info["genres"], strategy)
            strategy_freshness_mult = _freshness_strategy_multiplier(release_age, track_pop, strategy)
            track_boost *= strategy_genre_mult * strategy_freshness_mult

            # Track-level feedback: stronger signal than artist-level because
            # "I don't like THIS song" is more precise than "I don't like this artist"
            spotify_track_id = track.get("spotify_track_id") or ""
            track_fb = track_feedback.get(spotify_track_id, 0)
            if track_fb < 0:
                reason = track_feedback_reasons.get(spotify_track_id, "")
                track_boost *= 0.20 if reason in {"too_familiar", "too_far"} else 0.15
            elif track_fb > 0:
                track_boost *= 1.15  # Modest boost

            # Behavioral learning loop: implicit plays/favorites nudge tracks
            # up; skips and explicit refinement reasons nudge similar future
            # picks down without requiring a profile rebuild.
            t_events = track_events.get(spotify_track_id, Counter())
            a_events = artist_events.get(aid, Counter())
            positive_events = (
                t_events.get("play", 0)
                + t_events.get("favorite", 0) * 3
                + t_events.get("thumb_up", 0) * 2
            )
            negative_events = (
                t_events.get("skip", 0)
                + t_events.get("thumb_down", 0) * 3
            )
            if positive_events:
                track_boost *= min(1.35, 1.0 + positive_events * 0.05)
            if negative_events:
                track_boost *= max(0.55, 1.0 - negative_events * 0.08)

            too_familiar_count = (
                t_events.get("too_familiar", 0)
                + a_events.get("too_familiar", 0)
                + (1 if track_feedback_reasons.get(spotify_track_id) == "too_familiar" else 0)
            )
            too_far_count = (
                t_events.get("too_far", 0)
                + a_events.get("too_far", 0)
                + (1 if track_feedback_reasons.get(spotify_track_id) == "too_far" else 0)
            )
            if too_familiar_count and (track_pop >= 0.68 or in_library or is_library_artist):
                track_boost *= max(0.60, 1.0 - min(too_familiar_count, 4) * 0.08)
            if too_far_count and track_pop < 0.50 and not is_library_artist:
                track_boost *= max(0.55, 1.0 - min(too_far_count, 4) * 0.10)

            novelty = _novelty_score(
                track_pop,
                a_info["editorial"],
                in_library,
                is_library_artist,
                release_age,
            )
            saved_anchor_signal = track_affinity
            if is_library_artist:
                if station_distance == "closer":
                    saved_anchor_signal = min(1.0, saved_anchor_signal * 1.10)
                elif station_distance == "further":
                    saved_anchor_signal *= 0.90

            # ── Build reasons (needed by _lane_for_track below) ───────────────
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
            if strategy_genre_mult > 1.0:
                reasons.append("Fits your taste strategy")
            elif strategy_genre_mult < 1.0:
                reasons.append("Softened by your taste strategy")
            if not reasons:
                reasons.append("Curated pick")

            # ── Single lane assignment using the richer function ─────────────
            # _lane_for_track considers genres (indie/underground) and reasons
            # in addition to popularity, giving more accurate lane labels.
            # This is computed before the boost so deep cuts get quality scoring.
            lane = _lane_for_track(
                track_pop,
                a_info["genres"],
                reasons,
                a_info["editorial"],
                release_age,
            )
            if (
                user_prefers_instrumental
                and _instrumentalness is not None
                and _instrumentalness > 0.65
                and (audio_match_value or 0.0) >= 0.75
            ):
                lane = "deep_cuts"
                reasons.append("Matches your instrumental saves")

            if (
                favorites_match_value is not None
                and favorites_match_value >= FAVORITES_REASON_THRESHOLD
            ):
                reasons.append("Close to your favorites")

            dcq = 0.0
            if lane == "deep_cuts":
                dcq = _deep_cut_quality(
                    track_pop, a_info["editorial"], track_context,
                    track_affinity, is_library_artist, used_track_embedding,
                )
                # Within the deep-cut lane, quality is the whole ranking — a
                # wide spread here is what separates a worthwhile discovery
                # from a random album track.
                track_boost *= 0.88 + 0.24 * dcq
            else:
                # _novelty_score is 45% raw (1 - track_pop), so a wide
                # multiplier here was a fourth obscurity payment inside the
                # lanes that are supposed to hold recognizable songs. Keep it
                # as a light tiebreak between otherwise comparable tracks.
                track_boost *= 0.96 + 0.08 * novelty

            # Exploration
            exploration = rng.uniform(-EXPLORATION_STRENGTH, EXPLORATION_STRENGTH)

            final_score = track_base * track_boost + exploration

            familiarity_score = 0.0
            if in_library:
                familiarity_score = 1.0
            elif is_library_artist:
                familiarity_score = 0.6
            elif aid in previously_recommended:
                familiarity_score = 0.3

            novelty_score = 1.0 - familiarity_score

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
                "novelty_score": round(novelty_score, 4),
                "familiarity_score": round(familiarity_score, 4),
                "signals": {
                    "affinity": round(track_affinity, 4),
                    "context": round(track_context, 4),
                    "editorial": round(a_info["editorial"], 4),
                    "track_popularity": round(track_pop, 4),
                    "novelty": round(novelty, 4),
                    "familiarity": round(1.0 - novelty, 4),
                    "track_embedding": used_track_embedding,
                    "deep_cut_quality": round(dcq, 4),
                    "saved_anchor": round(saved_anchor_signal, 4),
                    "listen_boost": round(artist_listen_boost.get(aid, 0.0), 4),
                    "audio_match": round(audio_match_value, 4) if audio_match_value is not None else None,
                    "favorites_match": round(favorites_match_value, 4) if favorites_match_value is not None else None,
                    "live_source": False,
                },
                "lane": lane,
                "genres": a_info["genres"],
                "reasons": reasons,
                "mention_count": a_info["mention_count"],
                "top_mention": a_info["best_mention"],
            })

    # Sort by score
    song_results.sort(key=lambda s: s["score"], reverse=True)

    MIN_RESULTS = min(15, limit)
    if genre_filtered and len(song_results) < MIN_RESULTS:
        print(
            f"song_ranking: genre-filtered search produced only "
            f"{len(song_results)} songs — supplementing with genre-matched artists"
        )
        # First pass: try to supplement with more genre-matching artists
        # (wider pool, popularity-ordered instead of taste-ordered).
        artist_match_started = _time.monotonic()
        supp_artists = match_artists(
            client,
            query_vector=None,
            match_count=POOL_SIZE,
            genre_tokens=genre_tokens,
        )
        supplement_artist_ids_set = {int(a["id"]) for a in supp_artists if a.get("id") is not None}
        existing_artist_ids = {int(r["artist_id"]) for r in song_results if r.get("artist_id")}
        new_artist_ids = [
            aid for aid in supplement_artist_ids_set
            if aid not in existing_artist_ids and aid not in excluded_artist_ids
        ]
        # If genre-matched supplement is still too sparse, fall back to
        # the full catalog but only accept artists whose genres overlap
        # with the search tokens.
        if len(new_artist_ids) < MIN_RESULTS - len(song_results):
            full_artists = match_artists(
                client,
                query_vector=taste_vector or None,
                match_count=POOL_SIZE,
            )
            for a in full_artists:
                aid = a.get("id")
                if aid is None:
                    continue
                aid_int = int(aid)
                if aid_int in supplement_artist_ids_set or aid_int in existing_artist_ids:
                    continue
                if aid_int in excluded_artist_ids:
                    continue
                artist_genres = " ".join(g.lower() for g in (a.get("genres") or []))
                if any(t in artist_genres for t in genre_tokens):
                    new_artist_ids.append(aid_int)
                    supplement_artist_ids_set.add(aid_int)
            supp_artists = full_artists
        _record_stage("artist_match_rpc_ms", artist_match_started)
        if new_artist_ids:
            supplement_track_fetch_started = _time.monotonic()
            supp_tracks = _fetch_tracks_for_artist_ids(client, new_artist_ids[:200])
            _record_stage("track_fetch_ms", supplement_track_fetch_started)
            supp_by_artist: dict[int, list[dict]] = {}
            for t in supp_tracks:
                aid = t.get("artist_id")
                if aid is not None and not should_exclude_utility_track(
                    t,
                    allow_instrumental_utility=allow_instrumental_utility_tracks,
                ):
                    supp_by_artist.setdefault(int(aid), []).append(t)

            existing_name_keys = {
                f"{(r.get('track_name') or '').lower()}|{(r.get('artist_name') or '').lower()}"
                for r in song_results
            }
            for aid in new_artist_ids[:200]:
                if len(song_results) >= limit:
                    break
                a_info = artist_scores.get(aid)
                if not a_info:
                    for a in supp_artists:
                        if a.get("id") is not None and int(a["id"]) == aid:
                            a_info = {
                                "name": a.get("name") or "Unknown",
                                "genres": list(a.get("genres") or []),
                                "affinity": 0.0, "affinity_raw": 0.0,
                                "context": 0.0, "editorial": 0.0,
                                "base_score": 0.0,
                                "best_mention": None, "mention_count": 0,
                                "spotify_artist_id": a.get("spotify_artist_id"),
                            }
                            break
                if not a_info:
                    continue
                for track in (supp_by_artist.get(aid) or [])[:2]:
                    tname = (track.get("name") or "").strip()
                    name_key = f"{tname.lower()}|{a_info['name'].lower()}"
                    if name_key in existing_name_keys:
                        continue
                    existing_name_keys.add(name_key)
                    track_pop = _effective_track_pop(track, aid)
                    song_results.append({
                        "track_id": str(track["id"]) if track.get("id") else None,
                        "track_name": tname,
                        "artist_id": str(aid),
                        "artist_name": a_info["name"],
                        "album_name": track.get("album_name") or "",
                        "release_date": track.get("release_date"),
                        "duration_ms": track.get("duration_ms") or 0,
                        "explicit": track.get("explicit") or False,
                        "spotify_track_id": (track.get("spotify_track_id") or "").strip(),
                        "score": round(max(0.0, track_pop * 0.3), 4),
                        "lane": "popular",
                        "novelty_score": 0.8,
                        "familiarity_score": 0.2,
                        "signals": {
                            "affinity": 0.0, "context": 0.0, "editorial": 0.0,
                            "track_popularity": round(track_pop, 4),
                            "novelty": 0.8, "familiarity": 0.2,
                            "track_embedding": False,
                            "saved_anchor": 0.0,
                            "listen_boost": 0.0,
                            "audio_match": None,
                            "live_source": False,
                        },
                        "genres": a_info["genres"],
                        "reasons": ["Curated pick"],
                        "mention_count": 0,
                        "top_mention": None,
                    })

        song_results.sort(key=lambda s: s["score"], reverse=True)

    # ── Lane-aware diversity re-ranking ──────────────────────────
    # The old path sorted one blended list and let hits crowd out discovery.
    # This enforces a Pandora-like station mix: some recognizable anchors,
    # plenty of solid popular cuts, and a real deep-cut lane.
    rerank_started = _time.monotonic()
    diverse = _lane_aware_rerank(song_results, max(limit, 0), strategy)
    _record_stage("rerank_ms", rerank_started)

    return diverse


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

    # The frontier used to run ~700 artists deep for a 30-song station. With a
    # one-song-per-artist cap downstream, that meant the result was drawn from
    # a pool where the user's genuinely strong matches were outnumbered ~6:1 by
    # the tail — so most picks came from artists that barely matched at all.
    # Keep the tail (it is what makes repeat sessions feel different) but size
    # it so strong matches remain the bulk of the pool.
    frontier_size = min(len(ranked_artist_ids), max(limit * 10, 250))
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

    # Ticket weighting is relative to the best score in the pool. The old
    # formula used `int(score * 6)`, which collapsed to 0 tickets for every
    # artist scoring under ~0.17 and made the lottery close to uniform across
    # the tail regardless of taste.
    pool_scores = {
        aid: max(float(artist_scores.get(aid, {}).get("base_score") or 0.0), 0.0)
        for aid in frontier_pool
    }
    best_score = max(pool_scores.values(), default=0.0)

    weighted_pool: list[int] = []
    for idx, aid in enumerate(frontier_pool):
        share = (pool_scores[aid] / best_score) if best_score > 0 else 0.0
        # 1–12 tickets by relative score, plus a small bonus for the artists
        # just below the head so the near-misses rotate in most often.
        tickets = max(1, round(12 * share)) + max(0, 3 - idx // max(limit, 1))
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


def _lane_aware_rerank(scored: list[dict], limit: int, strategy: dict | None = None) -> list[dict]:
    if not scored or limit <= 0:
        return []

    unique_artists = len({(r.get("artist_name") or "").lower() for r in scored})
    initial_cap = 1 if unique_artists >= limit else 2

    pools: dict[str, list[dict]] = {lane: [] for lane in DISCOVERY_LANES}
    for row in scored:
        lane = row.get("lane") if row.get("lane") in DISCOVERY_LANES else "popular"
        pools[lane].append(row)

    for lane, rows in pools.items():
        rows.sort(
            key=lambda r: float(r.get("score") or 0.0),
            reverse=True,
        )

    targets = _lane_targets(limit, strategy)
    selected: list[dict] = []
    used: set[str] = set()
    artist_counts: Counter[str] = Counter()
    genre_counts: Counter[str] = Counter()

    # Lane order matters because of the one-song-per-artist cap: whichever
    # lane picks first claims its artists outright, and every other song by
    # those artists is then locked out. Running deep_cuts first meant an
    # artist whose signature song was a radio hit got represented by their
    # album filler instead, and the hit could never appear — the deep-cut
    # quota was effectively being paid for twice, once in slots and once in
    # which song each artist contributed. Filling the recognizable lanes
    # first gives every artist its best song, and the deep-cut lane then
    # draws from artists whose best song is genuinely a deep cut. The mix
    # itself is unchanged; only the artist-to-lane assignment moves.
    for lane in ("radio_hits", "popular", "deep_cuts"):
        selected.extend(
            _pick_lane_candidates(
                pools[lane],
                targets[lane],
                used,
                artist_counts,
                genre_counts,
                strict_artist_cap=initial_cap,
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
                strict_artist_cap=initial_cap,
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
                strict_artist_cap=initial_cap,
            )
        )

    # Last resort: relax artist cap only when unique artists are genuinely
    # exhausted — allows duplicates rather than returning fewer results.
    if len(selected) < limit:
        selected.extend(
            _pick_lane_candidates(
                scored,
                limit - len(selected),
                used,
                artist_counts,
                genre_counts,
                strict_artist_cap=3,
            )
        )

    # Selection ran lane by lane, so `selected` came out grouped deep_cuts →
    # popular → radio_hits: every station's first track was its most obscure
    # one, and the frontend's playback interleave inherited that ordering.
    # The lane quotas above already fixed the *mix*; ordering by score keeps
    # that mix while letting the strongest picks lead.
    selected.sort(key=lambda row: float(row.get("score") or 0.0), reverse=True)

    return selected[:limit]


_song_diversity_rerank = _lane_aware_rerank
