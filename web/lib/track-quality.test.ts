import { describe, expect, it } from "vitest";
import { isUtilityArtistName, isUtilityTrack } from "./track-quality";

describe("isUtilityArtistName", () => {
  it("catches playlist-farm names observed in live stations", () => {
    expect(isUtilityArtistName("Clean Pop Music")).toBe(true);
    expect(isUtilityArtistName("Synthwave Nation")).toBe(true);
    expect(isUtilityArtistName("summer sax")).toBe(true);
    // Mood-farm names that flooded mood-prompt searches.
    expect(isUtilityArtistName("Soft Soundscapes")).toBe(true);
    expect(isUtilityArtistName("Cozy Coffee Shop")).toBe(true);
    expect(isUtilityArtistName("Restaurant Lounge Background Music")).toBe(true);
  });

  it("keeps real artists that contain generic words", () => {
    expect(isUtilityArtistName("Clean Bandit")).toBe(false);
    expect(isUtilityArtistName("Nation of Language")).toBe(false);
    expect(isUtilityArtistName("Summer Walker")).toBe(false);
    expect(isUtilityArtistName("Pop Smoke")).toBe(false);
    expect(isUtilityArtistName("Soft Cell")).toBe(false);
    expect(isUtilityArtistName("Barry White")).toBe(false);
  });

  it("catches mood-farm album/title signatures", () => {
    expect(isUtilityTrack({ name: "Cozy Evening - BGM Mix" })).toBe(true);
    expect(isUtilityTrack({ name: "The Velvet Key", album: { name: "New York Jazz Piano Bar - Chill Jazz Music For Luxury Hotels and Fancy Restaurants, Vol. 3" } })).toBe(true);
    expect(isUtilityTrack({ name: "Midnight Study Lights" })).toBe(true);
  });

  it("never matches single-word names", () => {
    expect(isUtilityArtistName("Music")).toBe(false);
    expect(isUtilityArtistName("Karaoke")).toBe(false);
  });
});

describe("isUtilityTrack", () => {
  it("catches 'no lyrics' titles including the common misspelling", () => {
    expect(isUtilityTrack({ name: "Study Pop No Lyricss" })).toBe(true);
  });

  it("catches utility artists via the Spotify artists array", () => {
    expect(isUtilityTrack({ name: "Africa", artists: [{ name: "summer sax" }] })).toBe(true);
  });

  it("catches chill/synthwave radio album titles", () => {
    expect(
      isUtilityTrack({ name: "Vaporwave Chillwave", album: { name: "Synthwave Radio" } })
    ).toBe(true);
  });

  it("keeps normal songs", () => {
    expect(isUtilityTrack({ name: "Kiss City", artists: [{ name: "Blondshell" }] })).toBe(false);
    expect(isUtilityTrack({ name: "Radio", artists: [{ name: "Lana Del Rey" }] })).toBe(false);
  });
});
