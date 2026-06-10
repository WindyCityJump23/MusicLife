type ArtistRef = { name?: string | null };

type TrackQualityInput = {
  name?: string | null;
  album_name?: string | null;
  album?: {
    name?: string | null;
  } | null;
  // Spotify search returns an array; Supabase joins return a single object.
  artists?: ArtistRef[] | ArtistRef | null;
  artist_name?: string | null;
  instrumentalness?: number | null;
  speechiness?: number | null;
};

function primaryArtistName(track: TrackQualityInput): string | null | undefined {
  if (track.artist_name) return track.artist_name;
  const artists = track.artists;
  if (Array.isArray(artists)) return artists[0]?.name;
  return artists?.name;
}

const UTILITY_TRACK_PATTERNS = [
  /\binstrumental(?:\s+(?:version|mix|edit|remake|cover))?\b/i,
  /\btype\s+beat\b/i,
  /\b(?:free|rap|hip[- ]?hop|trap|drill|r&b|pop|lo[- ]?fi|chill)\s+beats?\b/i,
  /\bbeats?\s+(?:to\s+(?:study|relax|sleep)|for\s+(?:studying|sleep|focus))\b/i,
  /\bkaraoke\b/i,
  /\bbacking\s+track\b/i,
  /\b(?:meditation|sleep|study|focus|relaxation)\s+(?:music|sounds?|beats?)\b/i,
  /\b(?:slowed(?:\s*(?:and|&)\s*reverb)?|sped\s+up)\b/i,
  // Content-farm signatures observed in live stations ("Study Pop No
  // Lyricss", "Synthwave Mix (Synthwave Radio)", "Chill Upbeat Clean Pop
  // Music For Chilling"). "lyric" deliberately unanchored at the end so the
  // common "lyricss" misspelling still matches.
  /\bno\s+(?:lyric|vocal)/i,
  /\b(?:study|sleep|chill|focus|workout|relaxation)\s+(?:pop|hits|mix|radio|playlist)\b/i,
  /\b(?:synthwave|lo[- ]?fi|chill)\s+radio\b/i,
];

// Artist names composed ENTIRELY of generic utility/descriptor words are
// playlist-farm accounts, not bands ("Clean Pop Music", "Synthwave Nation",
// "summer sax"). Real artists almost always carry at least one non-generic
// token ("Clean Bandit", "Nation of Language", "Summer Walker"), so requiring
// every token to be generic — and at least two tokens — keeps this safe.
const GENERIC_ARTIST_TOKENS = new Set([
  "clean", "chill", "study", "sleep", "focus", "workout", "meditation",
  "relaxing", "relaxation", "calm", "summer", "winter", "sax", "saxophone",
  "piano", "guitar", "lofi", "lo", "fi", "synthwave", "ambient",
  "instrumental", "pop", "music", "beats", "radio", "nation", "vibes",
  "hits", "mix", "playlist", "station", "sounds", "songs", "cover",
  "covers", "tribute", "karaoke", "the", "and", "for", "of", "no", "lyrics",
]);

const UTILITY_REQUEST_PATTERNS = [
  /\binstrumental\b/i,
  /\btype\s+beat\b/i,
  /\bbeats?\b/i,
  /\bkaraoke\b/i,
  /\bbacking\s+track\b/i,
  /\bmeditation\s+music\b/i,
];

export function isExplicitUtilityTrackRequest(prompt: string): boolean {
  return UTILITY_REQUEST_PATTERNS.some((pattern) => pattern.test(prompt.trim()));
}

export function isUtilityArtistName(name: string | null | undefined): boolean {
  const tokens = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/[\s-]+/)
    .filter(Boolean);
  if (tokens.length < 2) return false;
  return tokens.every((token) => GENERIC_ARTIST_TOKENS.has(token));
}

export function isUtilityTrack(track: TrackQualityInput): boolean {
  if (typeof track.speechiness === "number" && track.speechiness > 0.75) return true;
  if (typeof track.instrumentalness === "number" && track.instrumentalness > 0.85) return true;
  if (isUtilityArtistName(primaryArtistName(track))) return true;
  const text = [track.name, track.album_name, track.album?.name].filter(Boolean).join(" ");
  return UTILITY_TRACK_PATTERNS.some((pattern) => pattern.test(text));
}
