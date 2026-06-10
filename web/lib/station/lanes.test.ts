import { describe, expect, it } from "vitest";
import {
  emptyDiscoveryGroups,
  groupSongsByLane,
  interleaveForPlayback,
  laneBadge,
  laneForSong,
  targetLaneCounts,
} from "./lanes";
import { makeSong } from "./fixtures";

describe("laneForSong", () => {
  it("honors an explicit backend lane over heuristics", () => {
    expect(laneForSong(makeSong({ lane: "deep_cut", signals: { affinity: 0, context: 0, editorial: 0, track_popularity: 0.99 } }))).toBe("deep_cuts");
    expect(laneForSong(makeSong({ lane: "familiar", signals: { affinity: 0, context: 0, editorial: 0, track_popularity: 0.1 } }))).toBe("radio_hits");
    expect(laneForSong(makeSong({ lane: "popular", signals: { affinity: 0, context: 0, editorial: 0, track_popularity: 0.99 } }))).toBe("popular");
  });

  it("falls back to popularity thresholds when no lane is set", () => {
    expect(laneForSong(makeSong({ signals: { affinity: 0, context: 0, editorial: 0, track_popularity: 0.2 } }))).toBe("deep_cuts");
    expect(laneForSong(makeSong({ signals: { affinity: 0, context: 0, editorial: 0, track_popularity: 0.6 } }))).toBe("popular");
    expect(laneForSong(makeSong({ signals: { affinity: 0, context: 0, editorial: 0, track_popularity: 0.8 } }))).toBe("radio_hits");
  });

  it("treats indie/underground/deep-cut signals as deep cuts even when popular", () => {
    expect(laneForSong(makeSong({ genres: ["indie rock"], signals: { affinity: 0, context: 0, editorial: 0, track_popularity: 0.9 } }))).toBe("deep_cuts");
    expect(laneForSong(makeSong({ reasons: ["deep cut"], signals: { affinity: 0, context: 0, editorial: 0, track_popularity: 0.9 } }))).toBe("deep_cuts");
  });

  it("defaults missing popularity to the 'popular' lane", () => {
    expect(laneForSong(makeSong())).toBe("popular");
  });
});

describe("laneBadge", () => {
  it("returns null when no backend lane is present", () => {
    expect(laneBadge(makeSong())).toBeNull();
  });
  it("labels each lane", () => {
    expect(laneBadge(makeSong({ lane: "deep_cut" }))?.label).toBe("Deep cut");
    expect(laneBadge(makeSong({ lane: "popular" }))?.label).toBe("Popular");
    expect(laneBadge(makeSong({ lane: "radio_hit" }))?.label).toBe("Radio hit");
  });
});

describe("targetLaneCounts", () => {
  it("handles tiny stations", () => {
    expect(targetLaneCounts(0)).toEqual({ radio_hits: 0, deep_cuts: 0 });
    expect(targetLaneCounts(1)).toEqual({ radio_hits: 1, deep_cuts: 0 });
    expect(targetLaneCounts(2)).toEqual({ radio_hits: 1, deep_cuts: 1 });
  });
  it("keeps radio_hits + deep_cuts under the total for a 25-song station", () => {
    const { radio_hits, deep_cuts } = targetLaneCounts(25);
    expect(radio_hits).toBeGreaterThanOrEqual(1);
    expect(deep_cuts).toBeGreaterThanOrEqual(1);
    expect(radio_hits + deep_cuts).toBeLessThanOrEqual(24);
  });
});

describe("groupSongsByLane", () => {
  it("returns empty groups for an empty list", () => {
    expect(groupSongsByLane([])).toEqual(emptyDiscoveryGroups());
  });

  it("partitions every song into exactly one lane with no loss", () => {
    const songs = Array.from({ length: 25 }, (_, i) =>
      makeSong({
        spotify_track_id: `sp_${i}`,
        signals: { affinity: 0.5, context: 0, editorial: 0, track_popularity: i / 25 },
      })
    );
    const groups = groupSongsByLane(songs);
    const total =
      groups.deep_cuts.length + groups.popular.length + groups.radio_hits.length;
    expect(total).toBe(25);
    const ids = new Set(
      [...groups.deep_cuts, ...groups.popular, ...groups.radio_hits].map(
        (s) => s.spotify_track_id
      )
    );
    expect(ids.size).toBe(25);
  });

  it("respects backend-preferred deep cuts", () => {
    const songs = [
      makeSong({ spotify_track_id: "a", lane: "deep_cut", signals: { affinity: 0, context: 0, editorial: 0, track_popularity: 0.95 } }),
      makeSong({ spotify_track_id: "b", signals: { affinity: 0, context: 0, editorial: 0, track_popularity: 0.95 } }),
    ];
    const groups = groupSongsByLane(songs);
    expect(groups.deep_cuts.map((s) => s.spotify_track_id)).toContain("a");
  });
});

describe("interleaveForPlayback", () => {
  it("preserves the full set of songs", () => {
    const songs = Array.from({ length: 12 }, (_, i) =>
      makeSong({ spotify_track_id: `sp_${i}`, signals: { affinity: 0.5, context: 0, editorial: 0, track_popularity: i / 12 } })
    );
    const mixed = interleaveForPlayback(songs);
    expect(mixed.length).toBe(12);
    expect(new Set(mixed.map((s) => s.spotify_track_id)).size).toBe(12);
  });

  it("returns an empty array for no songs", () => {
    expect(interleaveForPlayback([])).toEqual([]);
  });
});
