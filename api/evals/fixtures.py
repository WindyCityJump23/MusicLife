"""Synthetic test data and a mock Supabase client for offline evals.

All vector embeddings are small (8-dim), seeded, and unit-normalized so
tests run without any network calls or real embedding models.
"""
from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any


# ── Vector helpers ───────────────────────────────────────────────


def _rand_vec(dims: int = 8, seed: int = 0) -> list[float]:
    r = random.Random(seed)
    v = [r.gauss(0, 1) for _ in range(dims)]
    mag = math.sqrt(sum(x * x for x in v))
    return [x / mag for x in v] if mag > 0 else v


def _centroid(vecs: list[list[float]]) -> list[float]:
    if not vecs:
        return []
    dims = len(vecs[0])
    c = [sum(v[i] for v in vecs) / len(vecs) for i in range(dims)]
    mag = math.sqrt(sum(x * x for x in c))
    return [x / mag for x in c] if mag > 0 else c


# ── Mock Supabase client ─────────────────────────────────────────


class MockQueryBuilder:
    """Minimal Supabase query-builder shim for testing."""

    def __init__(self, data: list[dict]) -> None:
        self._data: list[dict] = list(data)
        self._negate_next = False

    # fluent no-ops
    def select(self, *args: Any, **kwargs: Any) -> "MockQueryBuilder":
        return self

    def order(self, *args: Any, **kwargs: Any) -> "MockQueryBuilder":
        return self

    def limit(self, *args: Any, **kwargs: Any) -> "MockQueryBuilder":
        return self

    def range(self, *args: Any) -> "MockQueryBuilder":
        return self

    # filters
    def eq(self, field: str, value: Any) -> "MockQueryBuilder":
        self._data = [r for r in self._data if r.get(field) == value]
        return self

    def in_(self, field: str, values: list) -> "MockQueryBuilder":
        s = set(values)
        self._data = [r for r in self._data if r.get(field) in s]
        return self

    @property
    def not_(self) -> "MockQueryBuilder":
        self._negate_next = True
        return self

    def is_(self, field: str, value: str) -> "MockQueryBuilder":
        if self._negate_next:
            if value == "null":
                self._data = [r for r in self._data if r.get(field) is not None]
            self._negate_next = False
        else:
            if value == "null":
                self._data = [r for r in self._data if r.get(field) is None]
        return self

    def execute(self) -> Any:
        data = self._data

        class _Resp:
            pass

        resp = _Resp()
        resp.data = data  # type: ignore[attr-defined]
        return resp


class MockSupabaseClient:
    def __init__(self, tables: dict[str, list[dict]]) -> None:
        self._tables = tables

    def table(self, name: str) -> MockQueryBuilder:
        return MockQueryBuilder(self._tables.get(name, []))


# ── Genre-correlated vector generation ──────────────────────────
#
# Purely random 8-dim vectors don't cluster by genre — the expected cosine
# between any two random unit vectors is 0 with σ ≈ 0.35.  Instead we
# create a "genre anchor" direction and blend each artist vector toward it
# (85% anchor + 15% artist-specific noise).  This ensures:
#   cosine(jazz_artist, jazz_taste_centroid) >> cosine(rock_artist, jazz_centroid)
# making taste-alignment evals reliable without requiring a real embedding model.

_JAZZ_ANCHOR = _rand_vec(8, seed=1000)
_ROCK_ANCHOR = _rand_vec(8, seed=2000)
_ELEC_ANCHOR = _rand_vec(8, seed=3000)


def _genre_vec(anchor: list[float], noise_seed: int, noise: float = 0.15) -> list[float]:
    """Return a unit vector that is predominantly in the anchor direction."""
    noise_v = _rand_vec(8, seed=noise_seed)
    mixed = [(1 - noise) * a + noise * n for a, n in zip(anchor, noise_v)]
    mag = math.sqrt(sum(x * x for x in mixed))
    return [x / mag for x in mixed] if mag > 0 else mixed


def _make_artist(
    artist_id: int,
    name: str,
    genres: list[str],
    vec_seed: int,
    popularity: int = 70,
    embedding: list[float] | None = None,
) -> dict:
    return {
        "id": artist_id,
        "name": name,
        "genres": genres,
        "embedding": embedding if embedding is not None else _rand_vec(8, seed=vec_seed),
        "popularity": popularity,
        "spotify_artist_id": f"sp_{artist_id}",
    }


JAZZ_ARTISTS = [
    _make_artist(1, "Miles Davis", ["jazz", "modal jazz"], vec_seed=1, popularity=85, embedding=_genre_vec(_JAZZ_ANCHOR, 1)),
    _make_artist(2, "John Coltrane", ["jazz", "hard bop"], vec_seed=2, popularity=80, embedding=_genre_vec(_JAZZ_ANCHOR, 2)),
    _make_artist(3, "Thelonious Monk", ["jazz", "bebop"], vec_seed=3, popularity=75, embedding=_genre_vec(_JAZZ_ANCHOR, 3)),
    _make_artist(4, "Bill Evans", ["jazz", "cool jazz"], vec_seed=4, popularity=70, embedding=_genre_vec(_JAZZ_ANCHOR, 4)),
    _make_artist(5, "Herbie Hancock", ["jazz", "jazz fusion"], vec_seed=5, popularity=72, embedding=_genre_vec(_JAZZ_ANCHOR, 5)),
]

ROCK_ARTISTS = [
    _make_artist(11, "Led Zeppelin", ["rock", "hard rock"], vec_seed=11, popularity=90, embedding=_genre_vec(_ROCK_ANCHOR, 11)),
    _make_artist(12, "Pink Floyd", ["rock", "progressive rock"], vec_seed=12, popularity=88, embedding=_genre_vec(_ROCK_ANCHOR, 12)),
    _make_artist(13, "The Beatles", ["rock", "pop rock"], vec_seed=13, popularity=95, embedding=_genre_vec(_ROCK_ANCHOR, 13)),
    _make_artist(14, "Radiohead", ["rock", "alternative rock"], vec_seed=14, popularity=82, embedding=_genre_vec(_ROCK_ANCHOR, 14)),
    _make_artist(15, "Tool", ["rock", "progressive metal"], vec_seed=15, popularity=78, embedding=_genre_vec(_ROCK_ANCHOR, 15)),
]

ELEC_ARTISTS = [
    _make_artist(21, "Aphex Twin", ["electronic", "ambient techno"], vec_seed=21, popularity=72, embedding=_genre_vec(_ELEC_ANCHOR, 21)),
    _make_artist(22, "Boards of Canada", ["electronic", "downtempo"], vec_seed=22, popularity=68, embedding=_genre_vec(_ELEC_ANCHOR, 22)),
    _make_artist(23, "Burial", ["electronic", "dubstep"], vec_seed=23, popularity=65, embedding=_genre_vec(_ELEC_ANCHOR, 23)),
    _make_artist(24, "Four Tet", ["electronic", "idm"], vec_seed=24, popularity=70, embedding=_genre_vec(_ELEC_ANCHOR, 24)),
    _make_artist(25, "Autechre", ["electronic", "idm"], vec_seed=25, popularity=60, embedding=_genre_vec(_ELEC_ANCHOR, 25)),
]

ALL_ARTISTS = JAZZ_ARTISTS + ROCK_ARTISTS + ELEC_ARTISTS

# Taste vectors: per-genre centroids serve as the user's weighted
# taste representation when exercising the ranking functions.
JAZZ_TASTE_VECTOR = _centroid([a["embedding"] for a in JAZZ_ARTISTS])
ROCK_TASTE_VECTOR = _centroid([a["embedding"] for a in ROCK_ARTISTS])
ELEC_TASTE_VECTOR = _centroid([a["embedding"] for a in ELEC_ARTISTS])


# ── Synthetic tracks ─────────────────────────────────────────────


def _make_track(
    track_id: int,
    name: str,
    artist_id: int,
    popularity: int = 70,
    vec_seed: int | None = None,
) -> dict:
    return {
        "id": track_id,
        "name": name,
        "artist_id": artist_id,
        "album_name": f"Album {track_id}",
        "duration_ms": 240000,
        "popularity": popularity,
        "spotify_track_id": f"sp_track_{track_id}",
        "explicit": False,
        "energy": None,
        "danceability": None,
        "valence": None,
        "tempo": None,
        "acousticness": None,
        "instrumentalness": None,
        "speechiness": None,
        "embedding": _rand_vec(8, seed=vec_seed or (track_id + 200)),
    }


TRACKS = [
    # Miles Davis (artist 1)
    _make_track(101, "Kind of Blue", 1, popularity=90, vec_seed=201),
    _make_track(102, "Bitches Brew", 1, popularity=75, vec_seed=202),
    # Coltrane (artist 2)
    _make_track(111, "A Love Supreme", 2, popularity=85, vec_seed=211),
    _make_track(112, "Giant Steps", 2, popularity=80, vec_seed=212),
    # Monk (artist 3)
    _make_track(121, "Round Midnight", 3, popularity=70, vec_seed=221),
    _make_track(122, "Straight No Chaser", 3, popularity=65, vec_seed=222),
    # Led Zeppelin (artist 11)
    _make_track(131, "Stairway to Heaven", 11, popularity=95, vec_seed=231),
    _make_track(132, "Kashmir", 11, popularity=88, vec_seed=232),
    # Pink Floyd (artist 12)
    _make_track(141, "Wish You Were Here", 12, popularity=90, vec_seed=241),
    _make_track(142, "Comfortably Numb", 12, popularity=88, vec_seed=242),
    # Aphex Twin (artist 21)
    _make_track(151, "Windowlicker", 21, popularity=72, vec_seed=251),
    _make_track(152, "Come to Daddy", 21, popularity=65, vec_seed=252),
]


# ── Synthetic mentions ───────────────────────────────────────────

SOURCES = [
    {"id": 1, "name": "Pitchfork", "trust_weight": 0.9},
    {"id": 2, "name": "Rolling Stone", "trust_weight": 0.85},
]


def _make_mention(
    mention_id: int,
    artist_id: int,
    source_id: int,
    sentiment: float = 0.8,
    days_ago: int = 10,
    excerpt: str = "A standout release.",
    vec_seed: int | None = None,
) -> dict:
    pub = datetime.now(timezone.utc) - timedelta(days=days_ago)
    return {
        "id": mention_id,
        "artist_id": artist_id,
        "source_id": source_id,
        "sentiment": sentiment,
        "published_at": pub.isoformat(),
        "excerpt": excerpt,
        "embedding": _rand_vec(8, seed=vec_seed or (mention_id + 100)),
    }


RECENT_MENTIONS = [
    _make_mention(1, 1, 1, sentiment=0.9, days_ago=5, excerpt="Miles Davis remains essential.", vec_seed=101),
    _make_mention(2, 2, 1, sentiment=0.85, days_ago=15, excerpt="Coltrane's influence endures.", vec_seed=102),
    _make_mention(3, 11, 2, sentiment=0.80, days_ago=20, excerpt="Led Zeppelin still rocks.", vec_seed=103),
]

STALE_MENTIONS = [
    _make_mention(10, 3, 1, sentiment=0.9, days_ago=90, excerpt="Monk was ahead of his time.", vec_seed=110),
]


# ── User scenarios ───────────────────────────────────────────────


@dataclass
class UserScenario:
    user_id: str
    library_artist_ids: list[int]
    played_track_ids: list[int]
    top_artist_ids: list[int]
    taste_vector: list[float]
    playlist_artist_ids: list[int] = field(default_factory=list)
    feedback: list[dict] = field(default_factory=list)  # [{"artist_id": int, "spotify_track_id": str, "feedback": 1|-1}]
    description: str = ""


JAZZ_USER = UserScenario(
    user_id="user_jazz",
    library_artist_ids=[1, 2, 3],
    played_track_ids=[101, 102, 111, 112, 121, 122],
    top_artist_ids=[1, 2, 3],
    taste_vector=JAZZ_TASTE_VECTOR,
    description="Jazz fan: Miles Davis, Coltrane, Monk in library",
)

ROCK_USER = UserScenario(
    user_id="user_rock",
    library_artist_ids=[11, 12, 13],
    played_track_ids=[131, 132, 141, 142],
    top_artist_ids=[11, 12, 13],
    taste_vector=ROCK_TASTE_VECTOR,
    description="Rock fan: Led Zeppelin, Pink Floyd, Beatles in library",
)

NEW_USER = UserScenario(
    user_id="user_new",
    library_artist_ids=[],
    played_track_ids=[],
    top_artist_ids=[],
    taste_vector=JAZZ_TASTE_VECTOR,  # cold-start: use jazz centroid as stand-in
    description="New user with no history",
)


# ── Client factory ───────────────────────────────────────────────


def build_mock_client(
    scenario: UserScenario,
    artists: list[dict] | None = None,
    tracks: list[dict] | None = None,
    mentions: list[dict] | None = None,
    sources: list[dict] | None = None,
) -> MockSupabaseClient:
    artists = artists if artists is not None else ALL_ARTISTS
    tracks = tracks if tracks is not None else TRACKS
    mentions = mentions if mentions is not None else (RECENT_MENTIONS + STALE_MENTIONS)
    sources = sources if sources is not None else SOURCES

    user_tracks = [
        {
            "user_id": scenario.user_id,
            "track_id": tid,
            "play_count": 5,
            "last_played_at": datetime.now(timezone.utc).isoformat(),
        }
        for tid in scenario.played_track_ids
    ]

    user_top_artists = [
        {
            "user_id": scenario.user_id,
            "artist_id": aid,
            "term": "short_term",
            "rank": i + 1,
        }
        for i, aid in enumerate(scenario.top_artist_ids)
    ]

    playlists: list[dict] = []
    playlist_items: list[dict] = []
    if scenario.playlist_artist_ids:
        playlists.append({"id": 1, "user_id": scenario.user_id, "name": "Saved"})
        for aid in scenario.playlist_artist_ids:
            playlist_items.append({"playlist_id": 1, "artist_id": aid})

    user_feedback = [
        {
            "user_id": scenario.user_id,
            "artist_id": row.get("artist_id"),
            "spotify_track_id": row.get("spotify_track_id", f"sp_fb_{i}"),
            "feedback": row["feedback"],
        }
        for i, row in enumerate(scenario.feedback)
    ]

    return MockSupabaseClient(
        {
            "artists": artists,
            "tracks": tracks,
            "user_tracks": user_tracks,
            "user_top_artists": user_top_artists,
            "mentions": mentions,
            "sources": sources,
            "playlists": playlists,
            "playlist_items": playlist_items,
            "user_feedback": user_feedback,
        }
    )
