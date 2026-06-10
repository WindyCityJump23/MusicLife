import { describe, expect, it } from "vitest";
import {
  buildWhyExplanation,
  pct,
  readableReason,
  summarizeWhy,
  topSignal,
} from "./explanation";
import { makeSong } from "./fixtures";

describe("pct", () => {
  it("clamps and rounds to an integer percentage", () => {
    expect(pct(undefined)).toBe(0);
    expect(pct(-1)).toBe(0);
    expect(pct(2)).toBe(100);
    expect(pct(0.756)).toBe(76);
  });
});

describe("topSignal", () => {
  it("picks the strongest of taste/search/buzz", () => {
    expect(topSignal(makeSong({ signals: { affinity: 0.3, context: 0.8, editorial: 0.1 } })).label).toBe("Search");
    expect(topSignal(makeSong({ signals: { affinity: 0.9, context: 0.1, editorial: 0.1 } })).label).toBe("Taste");
    expect(topSignal(makeSong({ signals: { affinity: 0.1, context: 0.1, editorial: 0.7 } })).label).toBe("Buzz");
  });
});

describe("readableReason", () => {
  it("maps known reason tags to friendly clauses", () => {
    expect(readableReason("matches your taste")).toBe("matches your taste profile");
    expect(readableReason("outside catalog")).toBe("was found through fresh Spotify discovery");
  });
  it("lowercases the first letter of unknown reasons", () => {
    expect(readableReason("Something New")).toBe("something New");
  });
});

describe("summarizeWhy — distinguishing leads", () => {
  const leader = { label: "Taste", value: 0.86 };

  it("leads with favorites proximity above everything else", () => {
    const song = makeSong({
      top_mention: { source: "Stereogum", excerpt: "x", published_at: "" },
      signals: { affinity: 0.8, context: 0, editorial: 0.5, favorites_match: 0.7 },
    });
    expect(summarizeWhy(song, "", leader)).toMatch(/^Close to songs you've favorited/);
  });

  it("leads with press context when an editorial mention exists", () => {
    const song = makeSong({
      top_mention: { source: "Stereogum", excerpt: "x", published_at: "" },
      signals: { affinity: 0.8, context: 0, editorial: 0.4 },
    });
    expect(summarizeWhy(song, "", leader)).toMatch(/^In the press at Stereogum/);
  });

  it("leads with the prompt when context is strong", () => {
    const song = makeSong({ signals: { affinity: 0.5, context: 0.7, editorial: 0 } });
    expect(summarizeWhy(song, "chicago indie", leader)).toMatch(/^Close match to "chicago indie"/);
  });

  it("leads with discovery framing for high-novelty, low-familiarity songs", () => {
    const song = makeSong({ signals: { affinity: 0.5, context: 0, editorial: 0, novelty: 0.8, familiarity: 0.1 } });
    expect(summarizeWhy(song, "", leader)).toMatch(/deeper cut/);
  });

  it("two different songs do not produce identical summaries", () => {
    const a = summarizeWhy(
      makeSong({ top_mention: { source: "Pitchfork", excerpt: "x", published_at: "" }, signals: { affinity: 0.8, context: 0, editorial: 0.5 } }),
      "",
      leader
    );
    const b = summarizeWhy(
      makeSong({ signals: { affinity: 0.5, context: 0, editorial: 0, novelty: 0.9, familiarity: 0 } }),
      "",
      leader
    );
    expect(a).not.toBe(b);
  });
});

describe("buildWhyExplanation", () => {
  it("returns a summary and de-duplicated detail bullets", () => {
    const song = makeSong({
      reasons: ["matches your taste", "matches your taste", "new release"],
      genres: ["indie pop", "dream pop"],
      signals: { affinity: 0.86, context: 0, editorial: 0 },
    });
    const { summary, details } = buildWhyExplanation(song, "");
    expect(summary.length).toBeGreaterThan(0);
    // de-dupe: the repeated "matches your taste" reason appears once
    const tasteBullets = details.filter((d) => d.includes("matches your taste profile"));
    expect(tasteBullets.length).toBe(1);
    expect(details[0]).toMatch(/strongest signal/i);
  });
});
