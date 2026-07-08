"""Unit tests for personal preset derivation (pure parts)."""

from app.services.taste_presets import MAX_PRESETS, derive_preset_definitions


def _members(genre_sets: list[list[str]], base_weight: float = 1.0) -> list[dict]:
    return [
        {"name": f"Artist {i}", "genres": genres, "weight": base_weight + i * 0.1}
        for i, genres in enumerate(genre_sets)
    ]


class TestDerivePresetDefinitions:
    def test_builds_prompt_and_label_from_top_genres(self):
        cluster = _members([
            ["dream pop", "indie"], ["dream pop", "shoegaze"],
            ["dream pop"], ["shoegaze", "dream pop"],
        ])
        presets = derive_preset_definitions([cluster])
        assert len(presets) == 1
        preset = presets[0]
        assert preset["prompt"].startswith("dream pop")
        assert preset["label"] == "Your Dream Pop Side"
        assert "dream pop" in preset["top_genres"]

    def test_small_clusters_skipped(self):
        cluster = _members([["jazz"], ["jazz"]])  # below the 4-member floor
        assert derive_preset_definitions([cluster]) == []

    def test_junk_genres_ignored(self):
        cluster = _members([
            ["seen live", "techno"], ["usa", "techno"],
            ["techno", "favorites"], ["techno", "spotify"],
        ])
        presets = derive_preset_definitions([cluster])
        assert presets[0]["label"] == "Your Techno Side"
        assert "seen live" not in presets[0]["top_genres"]

    def test_genreless_cluster_falls_back_to_artists(self):
        cluster = [
            {"name": "Anchor Act", "genres": [], "weight": 9.0},
            {"name": "Second Act", "genres": [], "weight": 2.0},
            {"name": "Third Act", "genres": [], "weight": 1.0},
            {"name": "Fourth Act", "genres": [], "weight": 0.5},
        ]
        presets = derive_preset_definitions([cluster])
        assert len(presets) == 1
        assert presets[0]["prompt"].startswith("like Anchor Act")
        assert "Anchor Act" in presets[0]["label"]

    def test_duplicate_prompts_deduped_and_capped(self):
        same_genre_cluster = _members([["house"]] * 5)
        clusters = [same_genre_cluster] * (MAX_PRESETS + 2)
        presets = derive_preset_definitions(clusters)
        assert len(presets) == 1  # identical prompts collapse

    def test_at_most_max_presets(self):
        clusters = [
            _members([[g]] * 5) for g in ("jazz", "techno", "folk", "metal", "ambient")
        ]
        presets = derive_preset_definitions(clusters)
        assert len(presets) == MAX_PRESETS
