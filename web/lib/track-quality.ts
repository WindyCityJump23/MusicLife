type TrackQualityInput = {
  name?: string | null;
  album_name?: string | null;
  album?: {
    name?: string | null;
  } | null;
  instrumentalness?: number | null;
  speechiness?: number | null;
};

const UTILITY_TRACK_PATTERNS = [
  /\binstrumental(?:\s+(?:version|mix|edit|remake|cover))?\b/i,
  /\btype\s+beat\b/i,
  /\b(?:free|rap|hip[- ]?hop|trap|drill|r&b|pop|lo[- ]?fi|chill)\s+beats?\b/i,
  /\bbeats?\s+(?:to\s+(?:study|relax|sleep)|for\s+(?:studying|sleep|focus))\b/i,
  /\bkaraoke\b/i,
  /\bbacking\s+track\b/i,
  /\b(?:meditation|sleep|study|focus|relaxation)\s+(?:music|sounds?|beats?)\b/i,
  /\b(?:slowed(?:\s*(?:and|&)\s*reverb)?|sped\s+up)\b/i,
];

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

export function isUtilityTrack(track: TrackQualityInput): boolean {
  if (typeof track.speechiness === "number" && track.speechiness > 0.75) return true;
  if (typeof track.instrumentalness === "number" && track.instrumentalness > 0.85) return true;
  const text = [track.name, track.album_name, track.album?.name].filter(Boolean).join(" ");
  return UTILITY_TRACK_PATTERNS.some((pattern) => pattern.test(text));
}
