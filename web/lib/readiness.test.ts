import { describe, expect, it } from "vitest";
import {
  completedStepNumbers,
  requiredArtistCount,
  requiredPlayableTrackCount,
  toRadioReadiness,
} from "./readiness";

describe("requiredArtistCount", () => {
  it("is zero with no artists", () => {
    expect(requiredArtistCount(0)).toBe(0);
  });
  it("floors at 5 for small libraries", () => {
    expect(requiredArtistCount(4)).toBe(4); // capped at artistCount
    expect(requiredArtistCount(8)).toBe(5);
  });
  it("scales to ~25% for larger libraries", () => {
    expect(requiredArtistCount(100)).toBe(25);
  });
});

describe("requiredPlayableTrackCount", () => {
  it("is zero with no artists", () => {
    expect(requiredPlayableTrackCount(0)).toBe(0);
  });
  it("floors at 10 and caps at 50", () => {
    expect(requiredPlayableTrackCount(8)).toBe(15); // 5 required artists * 3
    expect(requiredPlayableTrackCount(4)).toBe(12); // 4 required artists * 3
    expect(requiredPlayableTrackCount(1000)).toBe(50);
  });
});

describe("completedStepNumbers", () => {
  it("maps step flags to numbers", () => {
    const set = completedStepNumbers({ imported: true, enriched: true, modeledTracks: true });
    expect([...set].sort()).toEqual([1, 2, 6]);
  });
  it("returns empty for undefined", () => {
    expect(completedStepNumbers(undefined).size).toBe(0);
  });
});

describe("toRadioReadiness", () => {
  it("prefers the server radioReady flag when present", () => {
    const r = toRadioReadiness({
      stats: { artistCount: 40 },
      readiness: {
        radioReady: true,
        requiredArtistCount: 10,
        enrichedCount: 12,
        embeddedCount: 12,
        playableTrackCount: 40,
        requiredPlayableTrackCount: 30,
      },
    });
    expect(r.ready).toBe(true);
    expect(r.loading).toBe(false);
    expect(r.requiredArtistCount).toBe(10);
  });

  it("derives readiness when the server flag is absent", () => {
    const r = toRadioReadiness({
      stats: { artistCount: 40 },
      readiness: {
        requiredArtistCount: 10,
        enrichedCount: 5,
        embeddedCount: 5,
        playableTrackCount: 10,
        requiredPlayableTrackCount: 30,
      },
    });
    // enriched/embedded below required and tracks below required -> not ready
    expect(r.ready).toBe(false);
  });

  it("falls back to local formulas for missing required fields", () => {
    const r = toRadioReadiness({ stats: { artistCount: 100 }, readiness: {} });
    expect(r.requiredArtistCount).toBe(25);
    expect(r.requiredPlayableTrackCount).toBe(50);
  });
});
