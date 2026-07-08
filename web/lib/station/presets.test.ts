import { describe, expect, it } from "vitest";
import { CURATED_PRESETS, MAX_PRESET_CHIPS, presetsForToday } from "./presets";

describe("CURATED_PRESETS", () => {
  it("every preset has an id, label, prompt, and weights", () => {
    for (const p of CURATED_PRESETS) {
      expect(p.id).toBeTruthy();
      expect(p.label).toBeTruthy();
      expect(p.prompt.trim().length).toBeGreaterThan(0);
      expect(p.weights).toBeDefined();
    }
  });

  it("ids are unique", () => {
    const ids = CURATED_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every day of the week has at least one ritual preset", () => {
    for (let day = 0; day < 7; day++) {
      const hasRitual = CURATED_PRESETS.some((p) => p.days?.includes(day));
      expect(hasRitual, `day ${day} has no ritual preset`).toBe(true);
    }
  });
});

describe("presetsForToday", () => {
  it("puts the day's ritual first", () => {
    const sunday = new Date("2026-06-14T12:00:00Z"); // a Sunday
    const presets = presetsForToday(sunday);
    expect(presets[0].id).toBe("sunday-slowdown");
  });

  it("fills with evergreen presets up to the count", () => {
    const monday = new Date("2026-06-15T12:00:00Z");
    const presets = presetsForToday(monday, 4);
    expect(presets).toHaveLength(4);
    expect(presets[0].id).toBe("monday-reset");
    // The rest are evergreen (no days restriction).
    for (const p of presets.slice(1)) {
      expect(p.days).toBeUndefined();
    }
  });

  it("is deterministic for a given date", () => {
    const date = new Date("2026-06-17T09:00:00Z");
    expect(presetsForToday(date)).toEqual(presetsForToday(date));
  });

  it("rotates evergreen picks across weeks", () => {
    const week1 = presetsForToday(new Date("2026-06-16T12:00:00Z"), 4); // Tue
    const week2 = presetsForToday(new Date("2026-06-23T12:00:00Z"), 4); // next Tue
    // Same ritual chip, but the evergreen tail should differ across weeks.
    expect(week1.map((p) => p.id)).not.toEqual(week2.map((p) => p.id));
  });

  it("never exceeds sane chip counts", () => {
    expect(presetsForToday(new Date(), MAX_PRESET_CHIPS).length).toBeLessThanOrEqual(MAX_PRESET_CHIPS);
  });
});
