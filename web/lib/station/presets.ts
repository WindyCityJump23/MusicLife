/**
 * Mood presets — one-tap themed stations.
 *
 * A preset is a curated prompt + weight bundle: tapping one generates an
 * in-app station that is the user's taste profile refracted through the
 * theme (the prompt steers context matching; taste/affinity still anchors
 * candidate selection). Nothing touches Spotify playlists — creation stays
 * behind the explicit "Save as Playlist" action, which pre-names the
 * playlist after the preset.
 *
 * Curated presets here are day-aware; personal presets (derived from the
 * user's own taste clusters) come from /api/personal-presets and are merged
 * into the same chip row.
 */

import type { Preset } from "./types";

export type MoodPreset = {
  id: string;
  label: string;
  emoji?: string;
  /** The steering prompt sent through the normal station pipeline. */
  prompt: string;
  /** Personal presets from the API omit weights; THEME_WEIGHTS applies. */
  weights?: Preset["weights"];
  /** 0=Sunday … 6=Saturday. Omitted = evergreen (shown any day). */
  days?: number[];
  /** Personal presets are derived from the user's taste clusters. */
  personal?: boolean;
};

// Balanced default for themed stations: taste stays the anchor, context
// carries the theme, buzz stays light.
export const THEME_WEIGHTS: Preset["weights"] = { affinity: 55, context: 35, editorial: 10 };

export const CURATED_PRESETS: MoodPreset[] = [
  // ── Day-aware rituals ──────────────────────────────────────────
  { id: "monday-reset", label: "Monday Reset", emoji: "🌱", days: [1],
    prompt: "calm fresh start energizing morning", weights: THEME_WEIGHTS },
  { id: "midweek-focus", label: "Midweek Focus", emoji: "🎯", days: [2, 3],
    prompt: "deep focus flow instrumental-leaning steady", weights: THEME_WEIGHTS },
  { id: "thursday-lift", label: "Almost Friday", emoji: "🌤️", days: [4],
    prompt: "upbeat feel-good groove", weights: THEME_WEIGHTS },
  { id: "friday-night", label: "Friday Night", emoji: "🔥", days: [5],
    prompt: "party energy dance night out", weights: THEME_WEIGHTS },
  { id: "saturday-sun", label: "Saturday Sunshine", emoji: "☀️", days: [6],
    prompt: "sunny breezy weekend good mood", weights: THEME_WEIGHTS },
  { id: "sunday-slowdown", label: "Sunday Slowdown", emoji: "🌅", days: [0],
    prompt: "mellow slow morning acoustic warm", weights: THEME_WEIGHTS },

  // ── Evergreen moods ────────────────────────────────────────────
  { id: "workout", label: "Workout", emoji: "💪",
    prompt: "high energy workout intensity driving beat", weights: THEME_WEIGHTS },
  { id: "chill", label: "Chill", emoji: "🛋️",
    prompt: "chill relaxed laid back easygoing", weights: THEME_WEIGHTS },
  { id: "road-trip", label: "Road Trip", emoji: "🚗",
    prompt: "road trip driving singalong open road", weights: THEME_WEIGHTS },
  { id: "rainy-day", label: "Rainy Day", emoji: "🌧️",
    prompt: "rainy day moody introspective cozy", weights: THEME_WEIGHTS },
  { id: "dinner-party", label: "Dinner Party", emoji: "🍷",
    prompt: "warm sophisticated dinner background groove", weights: THEME_WEIGHTS },
  { id: "late-night", label: "Late Night", emoji: "🌙",
    prompt: "late night dark atmospheric slow burn", weights: THEME_WEIGHTS },

  // ── Discovery-flavored ─────────────────────────────────────────
  { id: "fresh-finds", label: "Fresh Finds", emoji: "✨",
    prompt: "new fresh recent releases discovery",
    weights: { affinity: 45, context: 30, editorial: 25 } },
];

/** Max chips shown in the row (personal presets take priority). */
export const MAX_PRESET_CHIPS = 6;

/**
 * The curated presets relevant *today*: this day's rituals first, then
 * evergreen moods to fill. Deterministic given a date (unit-tested).
 */
export function presetsForToday(date: Date = new Date(), count = 4): MoodPreset[] {
  const day = date.getDay();
  const todays = CURATED_PRESETS.filter((p) => p.days?.includes(day));
  const evergreen = CURATED_PRESETS.filter((p) => !p.days);
  // Rotate evergreen picks by ISO week so the row doesn't fossilize.
  const week = Math.floor(date.getTime() / (7 * 24 * 60 * 60 * 1000));
  const rotated = [...evergreen.slice(week % evergreen.length), ...evergreen.slice(0, week % evergreen.length)];
  return [...todays, ...rotated].slice(0, count);
}
