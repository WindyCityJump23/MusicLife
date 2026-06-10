/**
 * Per-song "Why this?" explanation logic.
 *
 * Pure functions extracted from discover-view.tsx so the recommendation copy —
 * the thing users actually read on every card — is unit-testable in isolation.
 */

import type { SongRecommendation } from "./types";

/** Clamp a 0–1 signal to an integer percentage. */
export function pct(value: number | undefined): number {
  return Math.round(Math.max(0, Math.min(1, value ?? 0)) * 100);
}

/** The strongest of the three headline signals (taste / search / buzz). */
export function topSignal(song: SongRecommendation): { label: string; value: number } {
  const signals = [
    { label: "Taste", value: song.signals.affinity ?? 0 },
    { label: "Search", value: song.signals.context ?? 0 },
    { label: "Buzz", value: song.signals.editorial ?? 0 },
  ];
  return signals.sort((a, b) => b.value - a.value)[0] ?? signals[0];
}

/** Turn a backend reason tag into a human-readable clause. */
export function readableReason(reason: string): string {
  const normalized = reason.trim();
  const lower = normalized.toLowerCase();
  if (lower === "matches your taste") return "matches your taste profile";
  if (lower === "matches your search") return "matches your prompt";
  if (lower === "fits your vibe") return "fits the current blend";
  if (lower === "popular track") return "has strong Spotify traction";
  if (lower === "new release") return "recent release";
  if (lower === "already in your library") return "familiar from your library";
  if (lower === "recently surfaced") return "recently surfaced in MusicLife";
  if (lower === "live spotify search") return "came from a fresh Spotify discovery";
  if (lower === "outside catalog") return "was found through fresh Spotify discovery";
  if (lower === "prompt expansion") return "matches a live expansion of your prompt";
  if (lower === "mood expansion") return "matches a live mood expansion";
  if (lower === "fresh genre search") return "came from a fresh live genre search";
  if (lower === "deep search") return "came from a deeper live search";
  if (lower === "recent search") return "came from a recent-year live search";
  if (lower === "curated pick") return "balanced discovery pick";
  return normalized.charAt(0).toLowerCase() + normalized.slice(1);
}

/**
 * Lead each card's "Why" with the single most *distinguishing* fact about the
 * song rather than the same generic "matches your taste; taste 8x%" template,
 * which made every row read identically.
 */
export function summarizeWhy(
  song: SongRecommendation,
  currentPrompt: string,
  leader: { label: string; value: number }
): string {
  const editorial = song.signals.editorial ?? 0;
  const context = song.signals.context ?? 0;
  const novelty = song.signals.novelty ?? 0;
  const familiarity = song.signals.familiarity ?? 0;
  const listenBoost = song.signals.listen_boost ?? 0;
  const savedAnchor = song.signals.saved_anchor ?? 0;
  const tail = ` · ${leader.label.toLowerCase()} ${pct(leader.value)}%`;

  if (song.top_mention?.source && editorial > 0.12) {
    return `In the press at ${song.top_mention.source}${tail}`;
  }
  if (currentPrompt.trim() && context >= 0.5) {
    return `Close match to "${currentPrompt.trim()}"${tail}`;
  }
  if (novelty >= 0.65 && familiarity < 0.45) {
    return `A deeper cut, more discovery than repeat${tail}`;
  }
  if (listenBoost >= 0.5 || savedAnchor >= 0.7) {
    return `From an artist you keep coming back to${tail}`;
  }
  const distinctGenre = song.genres.find((g) => g && g.length > 2);
  if (distinctGenre && (song.signals.affinity ?? 0) >= 0.6) {
    return `Strong ${distinctGenre} match${tail}`;
  }
  if (familiarity >= 0.45) {
    return `Stays close to music you already know${tail}`;
  }
  if (song.reasons.length > 0) {
    return `${readableReason(song.reasons[0])}${tail}`;
  }
  return `${leader.label} ${pct(leader.value)}%`;
}

/** Build the card summary plus the expanded "Why this song" detail bullets. */
export function buildWhyExplanation(
  song: SongRecommendation,
  currentPrompt: string
): { summary: string; details: string[] } {
  const leader = topSignal(song);
  const details: string[] = [];
  const seen = new Set<string>();

  function add(detail: string | null | undefined) {
    const clean = detail?.trim();
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    details.push(clean);
  }

  add(`${leader.label} is the strongest signal at ${pct(leader.value)}%.`);
  song.reasons.slice(0, 3).forEach((reason) => {
    add(`It ${readableReason(reason)}.`);
  });
  if (currentPrompt.trim() && (song.signals.context ?? 0) > 0.15) {
    add(`It lines up with "${currentPrompt.trim()}".`);
  }
  if (song.top_mention?.source) {
    add(`It has recent context from ${song.top_mention.source}.`);
  }
  if ((song.signals.novelty ?? 0) >= 0.65) {
    add("It should feel more discovery than repeat listen.");
  } else if ((song.signals.familiarity ?? 0) >= 0.45) {
    add("It stays close to music you already know.");
  }
  if (song.genres.length > 0) {
    add(`Genre fit: ${song.genres.slice(0, 3).join(", ")}.`);
  }

  return { summary: summarizeWhy(song, currentPrompt, leader), details };
}
