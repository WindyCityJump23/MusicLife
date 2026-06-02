import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase-server";
import { isExplicitUtilityTrackRequest, isUtilityTrack } from "@/lib/track-quality";

export const dynamic = "force-dynamic";

type StarterTrack = {
  id: number | null;
  name: string;
  artist_id: number | null;
  album_name: string | null;
  release_date: string | null;
  duration_ms: number | null;
  explicit: boolean | null;
  popularity: number | null;
  instrumentalness: number | null;
  speechiness: number | null;
  spotify_track_id: string | null;
  artists?: {
    id?: number;
    name?: string;
    genres?: string[] | null;
  } | null;
};

function firstArtist(artist: StarterTrack["artists"] | StarterTrack["artists"][]): StarterTrack["artists"] {
  return Array.isArray(artist) ? artist[0] ?? null : artist ?? null;
}

function cacheKey(prompt: string, strategy: unknown): string {
  return JSON.stringify({
    prompt: prompt.trim(),
    strategy: strategy ?? null,
  });
}

async function recordStationRun({
  userId,
  prompt,
  strategy,
  status,
  fallbackLevel,
  resultCount,
  latencyMs,
  sourceMix,
}: {
  userId: string;
  prompt: string | null;
  strategy: unknown;
  status: "cache" | "starter" | "empty";
  fallbackLevel: "cache" | "starter" | "empty";
  resultCount: number;
  latencyMs: number;
  sourceMix?: unknown;
}): Promise<string | null> {
  try {
    const { data, error } = await supabaseServer()
      .from("station_runs")
      .insert({
        user_id: userId,
        prompt,
        strategy: strategy && typeof strategy === "object" ? strategy : {},
        status,
        fallback_level: fallbackLevel,
        result_count: resultCount,
        latency_ms: latencyMs,
        source_mix: sourceMix && typeof sourceMix === "object" ? sourceMix : {},
        error_class: null,
      })
      .select("id")
      .maybeSingle();
    if (error) throw error;
    return typeof data?.id === "string" ? data.id : null;
  } catch (err) {
    console.warn("station-last: station run telemetry failed", err);
    return null;
  }
}

function laneForPopularity(popularity: number): "deep_cuts" | "popular" | "radio_hits" {
  if (popularity >= 78) return "radio_hits";
  if (popularity < 46) return "deep_cuts";
  return "popular";
}

function starterSong(row: StarterTrack) {
  const popularity = Math.max(0, Math.min(100, Number(row.popularity ?? 50)));
  const artist = firstArtist(row.artists);
  const lane = laneForPopularity(popularity);
  return {
    track_id: row.id ? String(row.id) : null,
    track_name: row.name ?? "",
    artist_id: row.artist_id ? String(row.artist_id) : "",
    artist_name: artist?.name ?? "Unknown artist",
    album_name: row.album_name ?? "",
    release_date: row.release_date ?? null,
    duration_ms: row.duration_ms ?? 0,
    explicit: Boolean(row.explicit),
    spotify_track_id: row.spotify_track_id ?? "",
    score: Math.max(0.35, Math.min(0.88, 0.45 + popularity / 220)),
    lane,
    novelty_score: lane === "deep_cuts" ? 0.8 : lane === "popular" ? 0.55 : 0.35,
    familiarity_score: lane === "radio_hits" ? 0.65 : lane === "popular" ? 0.45 : 0.25,
    signals: {
      affinity: 0.55,
      context: 0,
      editorial: 0,
      track_popularity: popularity / 100,
      novelty: lane === "deep_cuts" ? 0.8 : 0.55,
      familiarity: lane === "radio_hits" ? 0.65 : 0.35,
    },
    genres: artist?.genres ?? [],
    reasons: ["Starter mix"],
    mention_count: 0,
    top_mention: null,
  };
}

async function buildStarterStation(userId: string) {
  const sb = supabaseServer();

  const { data: favorites } = await sb
    .from("user_favorites")
    .select("track_id,created_at")
    .eq("user_id", userId)
    .not("track_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(60);

  const favoriteTrackIds = (favorites ?? [])
    .map((row: { track_id: number | null }) => row.track_id)
    .filter((id: number | null): id is number => typeof id === "number");

  const { data: userTracks } = await sb
    .from("user_tracks")
    .select("track_id,play_count,last_played_at,added_at")
    .eq("user_id", userId)
    .order("last_played_at", { ascending: false })
    .order("added_at", { ascending: false })
    .limit(160);

  const userTrackIds = (userTracks ?? [])
    .map((row: { track_id: number | null }) => row.track_id)
    .filter((id: number | null): id is number => typeof id === "number");

  const orderedIds = Array.from(new Set([...favoriteTrackIds, ...userTrackIds])).slice(0, 120);
  if (orderedIds.length === 0) return null;

  const { data: tracks, error } = await sb
    .from("tracks")
    .select("id,name,artist_id,album_name,release_date,duration_ms,explicit,popularity,instrumentalness,speechiness,spotify_track_id,artists(id,name,genres)")
    .in("id", orderedIds)
    .not("spotify_track_id", "is", null)
    .limit(50);

  if (error || !tracks || tracks.length < 8) return null;

  const byId = new Map<number, StarterTrack>();
  for (const track of tracks as StarterTrack[]) {
    if (track.id) byId.set(track.id, track);
  }

  const artistCounts = new Map<string, number>();
  const starter = orderedIds
    .map((id) => byId.get(id))
    .filter((track): track is StarterTrack => Boolean(track?.spotify_track_id))
    .filter((track) => !isUtilityTrack(track))
    .sort((a, b) => Number(b.popularity ?? 0) - Number(a.popularity ?? 0))
    .filter((track) => {
      const artistKey = String(track.artist_id ?? track.artists?.name ?? "unknown");
      const count = artistCounts.get(artistKey) ?? 0;
      if (count >= 2) return false;
      artistCounts.set(artistKey, count + 1);
      return true;
    })
    .slice(0, 25)
    .map(starterSong);

  if (starter.length < 8) return null;

  return {
    results: starter,
    fallback_level: "starter",
    source_mix: {
      catalogCount: starter.length,
      liveCount: 0,
      starter: true,
    },
  };
}

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  const user = requireUser(req);
  if (isErrorResponse(user)) return user;

  const sb = supabaseServer();
  const { searchParams } = new URL(req.url);
  const prompt = searchParams.get("prompt") ?? "";
  const strategyParam = searchParams.get("strategy");
  let strategy: unknown = null;
  try {
    strategy = strategyParam ? JSON.parse(strategyParam) : null;
  } catch {
    strategy = null;
  }
  const key = cacheKey(prompt, strategy);

  const { data: cached } = await sb
    .from("station_cache")
    .select("id,cache_key,prompt,strategy,results,source_mix,created_at,expires_at")
    .eq("user_id", user.userId)
    .eq("cache_key", key)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const cachedResults = Array.isArray(cached?.results)
    ? cached.results.filter((track) =>
        isExplicitUtilityTrackRequest(prompt) ||
        !isUtilityTrack({
          name: track?.track_name,
          album_name: track?.album_name,
        })
      )
    : [];

  if (cached && cachedResults.length > 0) {
    const runId = await recordStationRun({
      userId: user.userId,
      prompt: prompt.trim() || null,
      strategy,
      status: "cache",
      fallbackLevel: "cache",
      resultCount: cachedResults.length,
      latencyMs: Date.now() - startedAt,
      sourceMix: cached.source_mix ?? {},
    });
    return NextResponse.json({
      station_id: cached.id,
      run_id: runId,
      fallback_level: "cache",
      results: cachedResults,
      source_mix: cached.source_mix ?? {},
      cached_at: cached.created_at,
    });
  }

  if (!prompt.trim()) {
    const starter = await buildStarterStation(user.userId);
    if (starter) {
      const runId = await recordStationRun({
        userId: user.userId,
        prompt: null,
        strategy,
        status: "starter",
        fallbackLevel: "starter",
        resultCount: starter.results.length,
        latencyMs: Date.now() - startedAt,
        sourceMix: starter.source_mix,
      });
      return NextResponse.json({
        ...starter,
        station_id: runId,
        run_id: runId,
      });
    }
  }

  const runId = await recordStationRun({
    userId: user.userId,
    prompt: prompt.trim() || null,
    strategy,
    status: "empty",
    fallbackLevel: "empty",
    resultCount: 0,
    latencyMs: Date.now() - startedAt,
    sourceMix: {},
  });
  return NextResponse.json({
    station_id: runId,
    run_id: runId,
    fallback_level: "empty",
    results: [],
    source_mix: {},
  });
}
