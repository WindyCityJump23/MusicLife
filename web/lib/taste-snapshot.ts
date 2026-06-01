type SupabaseLike = {
  from: (table: string) => any;
};

const MEANINGFUL_EVENTS = [
  "play",
  "skip",
  "thumb_up",
  "thumb_down",
  "too_familiar",
  "too_far",
  "favorite",
  "save_playlist",
  "open_spotify",
];

export function isMeaningfulTasteEvent(eventType: string): boolean {
  return MEANINGFUL_EVENTS.includes(eventType);
}

function topEntries<T>(map: Map<string, T & { count: number }>, limit: number): Array<T & { count: number }> {
  return [...map.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

function normalizeSnapshotGenre(value: unknown): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (
    !normalized ||
    normalized.includes("_") ||
    normalized.includes("lidarr") ||
    normalized.includes("batch")
  ) {
    return "";
  }
  return normalized;
}

export async function createTasteSnapshot({
  sb,
  userId,
  reason,
  dedupeReason = false,
}: {
  sb: SupabaseLike;
  userId: string;
  reason: string;
  dedupeReason?: boolean;
}) {
  try {
    if (dedupeReason) {
      const { data: existing } = await sb
        .from("taste_snapshots")
        .select("id")
        .eq("user_id", userId)
        .contains("feedback_summary", { reason })
        .limit(1);
      if (Array.isArray(existing) && existing.length > 0) return;
    }

    const { data: userTracks } = await sb
      .from("user_tracks")
      .select("tracks(artist_id,artists(id,name,genres))")
      .eq("user_id", userId)
      .limit(1000);

    const genreCounts = new Map<string, { genre: string; count: number }>();
    const artistCounts = new Map<string, { id: number | null; name: string; count: number }>();
    for (const row of userTracks ?? []) {
      const track = Array.isArray(row.tracks) ? row.tracks[0] : row.tracks;
      const artist = Array.isArray(track?.artists) ? track.artists[0] : track?.artists;
      if (artist?.name) {
        const key = String(artist.id ?? artist.name);
        const current = artistCounts.get(key) ?? { id: artist.id ?? null, name: artist.name, count: 0 };
        current.count += 1;
        artistCounts.set(key, current);
      }
      for (const genre of artist?.genres ?? []) {
        const key = normalizeSnapshotGenre(genre);
        if (!key) continue;
        const current = genreCounts.get(key) ?? { genre: key, count: 0 };
        current.count += 1;
        genreCounts.set(key, current);
      }
    }

    const { data: events } = await sb
      .from("recommendation_events")
      .select("event_type")
      .eq("user_id", userId)
      .in("event_type", MEANINGFUL_EVENTS)
      .limit(1000);

    const eventCounts: Record<string, number> = {};
    for (const event of events ?? []) {
      const type = String(event.event_type ?? "");
      if (!type) continue;
      eventCounts[type] = (eventCounts[type] ?? 0) + 1;
    }

    const topGenres = topEntries(genreCounts, 8);
    const anchorArtists = topEntries(artistCounts, 8);
    const thesis = topGenres.length > 0
      ? `You lean toward ${topGenres.slice(0, 3).map((item) => item.genre).join(", ")}. Radio will use ${anchorArtists[0]?.name ?? "your strongest artists"} as an anchor while learning from recent feedback.`
      : "Radio will use your saved music as an anchor while learning from recent feedback.";

    await sb.from("taste_snapshots").insert({
      user_id: userId,
      top_genres: topGenres,
      anchor_artists: anchorArtists,
      feedback_summary: { reason, events: eventCounts },
      readiness: {},
      thesis,
    });
  } catch (err) {
    console.warn("taste snapshot skipped", err);
  }
}

export async function maybeCreateFeedbackTasteSnapshot({
  sb,
  userId,
  eventType,
}: {
  sb: SupabaseLike;
  userId: string;
  eventType: string;
}) {
  try {
    if (!isMeaningfulTasteEvent(eventType)) return;
    const { count } = await sb
      .from("recommendation_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .in("event_type", MEANINGFUL_EVENTS);
    if (typeof count === "number" && count > 0 && count % 10 === 0) {
      await createTasteSnapshot({
        sb,
        userId,
        reason: `feedback_milestone:${count}`,
        dedupeReason: true,
      });
    }
  } catch (err) {
    console.warn("feedback taste snapshot skipped", err);
  }
}
